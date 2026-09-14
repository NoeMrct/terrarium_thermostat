#include "console.h"
#include "stockage.h"
#include "sondes.h"
#include "reseau.h"
#include "affichage.h"
#include "format.h"
#include <time.h>

namespace {

String tampon;

String hhmm(uint16_t m) {
  char b[8]; formatHHMM(m, b, sizeof b);
  return String(b);
}

bool parseHHMM(const String &s, uint16_t &out) { return formatParseHHMM(s.c_str(), out); }

uint8_t decouper(const String &cmd, String jetons[6]) {
  uint8_t n = 0; int depart = 0;
  while (n < 6) {
    const int e = cmd.indexOf(' ', depart);
    if (e < 0) { jetons[n++] = cmd.substring(depart); break; }
    if (e > depart) jetons[n++] = cmd.substring(depart, e);
    depart = e + 1;
  }
  return n;
}

// Les réglages globaux passent tous par ici : mêmes bornes que l'interface web
// et que le canal MQTT, puisque la validation vit dans stockage.cpp.
bool appliquerGlobaux(const ReglagesGlobaux &n) {
  char erreur[100];
  if (!Stockage::globauxValides(n, erreur, sizeof erreur)) {
    Serial.printf("Refuse : %s\n", erreur);
    return false;
  }
  Stockage::globaux() = n;
  Stockage::sauverGlobaux();
  appliquerReglagesGlobaux();
  return true;
}

void appliquer(uint8_t z, const ReglagesZone &n) {
  char erreur[100];
  if (!reglagesValides(n, erreur, sizeof erreur)) { Serial.printf("Refuse : %s\n", erreur); return; }
  ctrl.cfg[z] = n;
  Stockage::sauverZone(z, n);
  const ReglagesZone &c = ctrl.cfg[z];
  Serial.printf("%s : jour %.1f  nuit %.1f  %s->%s  bande %.2f  ki %.5f  max %.1f  offset %+.2f\n",
                c.nom, c.consigneJour, c.consigneNuit, hhmm(c.debutJour).c_str(),
                hhmm(c.debutNuit).c_str(), c.bande, c.ki, c.tempMax, c.offset);
}

void traiter(String cmd) {
  cmd.trim();
  if (!cmd.length()) return;

  String j[6];
  const uint8_t n = decouper(cmd, j);
  const String &v = j[0];

  Affichage::reveiller();          // toute commande rallume l'écran

  if (v == "help")    { Console::aide(); return; }
  if (v == "jeton") {
    if (n >= 2 && j[1] == "nouveau") {
      Stockage::regenererJeton();
      Serial.println(F("Nouveau code genere : les applications deja appairees devront etre reappairees."));
    }
    Serial.printf("Code d'appairage : %s\n", Stockage::reseau().jeton);
    Affichage::appairage(Stockage::reseau().jeton, 15);
    return;
  }
  if (v == "version") {
    Serial.printf("Firmware %s, compile le %s\n", FW_VERSION, FW_BUILD);
    return;
  }
  if (v == "stats") {
    const ReglagesGlobaux &g = Stockage::globaux();
    Serial.printf("Alimentation %.1f A -> %u zone(s) simultanee(s)  |  saison %+.2f C\n",
                  g.courantAlimA, ctrl.limiteZones(), ctrl.decalageSaison());
    for (uint8_t z = 0; z < NB_ZONES; z++) {
      const uint32_t sec = secondesChauffeTotales(z);
      Serial.printf("  %-12s %6.1f h de chauffe  %6.3f kWh  defauts sonde/surchauffe/figee : %u/%u/%u\n",
                    ctrl.cfg[z].nom, sec / 3600.0f,
                    sec / 3600.0f * g.puissanceTapisW / 1000.0f,
                    ctrl.zone[z].nbDefauts[DEF_SONDE], ctrl.zone[z].nbDefauts[DEF_SURCHAUFFE],
                    ctrl.zone[z].nbDefauts[DEF_FIGE]);
    }
    return;
  }
  if (v == "status")  { Console::etat(); return; }
  if (v == "scan")    { Serial.print(Sondes::inventaireTexte()); return; }
  if (v == "journal") { Serial.println(Stockage::journalQueue(4000)); return; }
  if (v == "reseau") {
    const ReglagesReseau &r = Stockage::reseau();
    Serial.printf("SSID '%s'  etat %s  adresse %s\n", r.ssid,
                  Reseau::modePointAcces() ? "point d'acces de config" :
                  (Reseau::connecte() ? "connecte" : "hors ligne"), Reseau::adresse().c_str());
    Serial.printf("Web %s  OTA reseau %s  MQTT %s\n",
                  r.webUtilisateur[0] ? "protege" : "libre",
                  Reseau::otaActive() ? "active et protegee"
                                      : "DESACTIVEE (aucun mot de passe : `motdepasse ota <mdp>`)",
                  r.mqttActif ? r.mqttHote : "desactive");
    Serial.printf("Alertes %s%s  heartbeat %s (%u min)\n",
                  r.urlAlertes[0] ? r.urlAlertes : "desactivees",
                  r.alerteJeton[0] ? " [jeton]" : "",
                  r.urlHeartbeat[0] ? r.urlHeartbeat : "desactive", r.heartbeatMinutes);
    Serial.printf("Fuseau %s  NTP %s  heure %s  alertes en attente %u\n",
                  r.fuseau, r.ntp,
                  heureFiable() ? (horodatage() + (heureApproximative() ? " (approximative)" : "")).c_str()
                                : "inconnue",
                  Stockage::alertesEnAttente());
    return;
  }
  if (v == "reset") {
    ctrl.leverDefauts(millis());
    uint8_t d[NB_ZONES] = { DEF_AUCUN, DEF_AUCUN };
    Stockage::sauverDefauts(d);
    Serial.println(F("Defauts leves. Verifie sondes, tapis et cablage."));
    return;
  }
  if (v == "off") {
    // Verrouillage volontaire : on reutilise le mecanisme de defaut (c'est lui
    // qui survit a un redemarrage), mais sans compter une panne qui n'a pas eu
    // lieu dans les statistiques.
    for (uint8_t z = 0; z < NB_ZONES; z++) ctrl.declencherDefaut(z, DEF_SURCHAUFFE, millis(), false);
    Serial.println(F("Tout coupe et verrouille. `reset` pour repartir."));
    return;
  }
  if (v == "entretien") {
    const uint16_t min = (n >= 2) ? (uint16_t)j[1].toInt() : Stockage::globaux().maintenanceMin;
    if (min > 240) { Serial.println(F("Duree limitee a 240 min.")); return; }
    ctrl.maintenance(millis(), min);
    return;
  }
  if (v == "alim" && n >= 2) {
    ReglagesGlobaux g = Stockage::globaux();
    g.courantAlimA = j[1].toFloat();
    if (n >= 3) g.puissanceTapisW = j[2].toFloat();
    if (n >= 4) g.tensionV = j[3].toFloat();
    if (!appliquerGlobaux(g)) return;
    Serial.printf("Alimentation %.1f A sous %.1f V, tapis %.0f W -> %u zone(s) simultanee(s)\n",
                  g.courantAlimA, g.tensionV, g.puissanceTapisW, ctrl.limiteZones());
    return;
  }
  if (v == "entretien-defaut" && n >= 2) {
    ReglagesGlobaux g = Stockage::globaux();
    g.maintenanceMin = (uint16_t)j[1].toInt();
    if (!appliquerGlobaux(g)) return;
    Serial.printf("Duree d'entretien par defaut : %u min\n", g.maintenanceMin);
    return;
  }
  if (v == "saison") {
    ReglagesGlobaux g = Stockage::globaux();
    if (n >= 2 && j[1] == "off") {
      g.saisonActive = false;
      if (!appliquerGlobaux(g)) return;
      Serial.println(F("Cyclage saisonnier desactive."));
      return;
    }
    if (n >= 3) {
      g.saisonDelta = j[1].toFloat();
      g.saisonDescenteJ = (uint16_t)j[2].toInt();
      if (n >= 4) g.saisonPlateauJ = (uint16_t)j[3].toInt();
      if (n >= 5) g.saisonRemonteeJ = (uint16_t)j[4].toInt();
      if (!heureFiable()) { Serial.println(F("Heure inconnue : impossible de dater le cycle.")); return; }
      g.saisonDebutEpoch = (uint32_t)time(nullptr);
      g.saisonActive = true;
      if (!appliquerGlobaux(g)) return;
    }
    const ReglagesGlobaux &c = Stockage::globaux();
    Serial.printf("Saison %s : -%.1f C, %u j de descente, %u j de plateau, %u j de remontee (decalage actuel %+.2f C)\n",
                  c.saisonActive ? "active" : "inactive", c.saisonDelta,
                  c.saisonDescenteJ, c.saisonPlateauJ, c.saisonRemonteeJ, ctrl.decalageSaison());
    return;
  }
  if (v == "ecran" && n >= 2) {
    ReglagesGlobaux g = Stockage::globaux();
    g.ecranVeilleMin = (uint16_t)j[1].toInt();
    if (!appliquerGlobaux(g)) return;
    Serial.printf("Veille de l'ecran : %u min%s\n", g.ecranVeilleMin,
                  g.ecranVeilleMin == 0 ? " (jamais)" : "");
    return;
  }
  if (v == "redemarrer") { Serial.println(F("Redemarrage...")); delay(200); ESP.restart(); return; }
  if (v == "effacer-historique") { Stockage::histEffacer(); Serial.println(F("Historique efface.")); return; }

  if (v == "wifi" && n >= 2) {
    ReglagesReseau &r = Stockage::reseau();
    snprintf(r.ssid, sizeof r.ssid, "%s", j[1].c_str());
    if (n >= 3) snprintf(r.motDePasse, sizeof r.motDePasse, "%s", j[2].c_str());
    Stockage::sauverReseau();
    Serial.println(F("WiFi enregistre. `redemarrer` pour appliquer."));
    return;
  }
  if (v == "motdepasse" && n >= 3) {
    ReglagesReseau &r = Stockage::reseau();
    if (j[1] == "web") {
      if (n >= 4) snprintf(r.webUtilisateur, sizeof r.webUtilisateur, "%s", j[3].c_str());
      else if (!r.webUtilisateur[0]) snprintf(r.webUtilisateur, sizeof r.webUtilisateur, "admin");
      snprintf(r.webHachage, sizeof r.webHachage, "%s",
               Reseau::empreinte(String(r.webUtilisateur) + ":" + j[2]).c_str());
    }
    else if (j[1] == "ota") snprintf(r.otaMotDePasse, sizeof r.otaMotDePasse, "%s", j[2].c_str());
    else if (j[1] == "ap") {
      if (j[2].length() < 8) { Serial.println(F("8 caracteres minimum pour le point d'acces.")); return; }
      snprintf(r.apMotDePasse, sizeof r.apMotDePasse, "%s", j[2].c_str());
    }
    else { Serial.println(F("Usage : motdepasse <web|ota|ap> <mot de passe> [utilisateur]")); return; }
    Stockage::sauverReseau();
    Serial.println(F("Enregistre. `redemarrer` pour appliquer."));
    return;
  }
  if (v == "url" && n >= 3) {
    ReglagesReseau &r = Stockage::reseau();
    if (j[1] == "alertes")        snprintf(r.urlAlertes, sizeof r.urlAlertes, "%s", j[2].c_str());
    else if (j[1] == "heartbeat") snprintf(r.urlHeartbeat, sizeof r.urlHeartbeat, "%s", j[2].c_str());
    else if (j[1] == "jeton")     snprintf(r.alerteJeton, sizeof r.alerteJeton, "%s",
                                           j[2] == "off" ? "" : j[2].c_str());
    else { Serial.println(F("Usage : url <alertes|heartbeat|jeton> <valeur>")); return; }
    Stockage::sauverReseau();
    Serial.println(F("Enregistre."));
    return;
  }
  if (v == "mqtt" && n >= 3 && j[1] == "tls") {
    Stockage::reseau().mqttTls = (j[2] == "on" || j[2] == "1");
    if (Stockage::reseau().mqttTls && Stockage::reseau().mqttPort == 1883)
      Stockage::reseau().mqttPort = 8883;
    Stockage::sauverReseau();
    Serial.printf("MQTT chiffre : %s (port %u). `redemarrer` pour appliquer.\n",
                  Stockage::reseau().mqttTls ? "oui" : "non", Stockage::reseau().mqttPort);
    return;
  }
  if (v == "mqtt" && n >= 2) {
    ReglagesReseau &r = Stockage::reseau();
    snprintf(r.mqttHote, sizeof r.mqttHote, "%s", j[1] == "off" ? "" : j[1].c_str());
    if (n >= 3) r.mqttPort = (uint16_t)j[2].toInt();
    if (n >= 6) r.mqttTls = (j[5] == "tls" || j[5] == "1");
    if (n >= 5) { snprintf(r.mqttUtilisateur, sizeof r.mqttUtilisateur, "%s", j[3].c_str());
                  snprintf(r.mqttMotDePasse, sizeof r.mqttMotDePasse, "%s", j[4].c_str()); }
    if (r.mqttPort == 0) r.mqttPort = 1883;
    r.mqttActif = r.mqttHote[0] != '\0';
    Stockage::sauverReseau();
    Serial.println(F("MQTT enregistre. `redemarrer` pour appliquer."));
    return;
  }
  if (v == "lier" && n >= 3) {
    const int idx = j[1].toInt(), z = j[2].toInt();
    if (z < 1 || z > (int)NB_ZONES) { Serial.println(F("Zone invalide.")); return; }
    Serial.println(Sondes::lierParIndex((uint8_t)idx, (uint8_t)(z - 1))
                   ? F("Sonde liee.") : F("Index de sonde introuvable."));
    return;
  }

  // --- commandes de zone ---
  if (n < 2) { Serial.println(F("Commande inconnue. `help`.")); return; }
  const int numZ = j[1].toInt();
  if (numZ < 1 || numZ > (int)NB_ZONES) { Serial.println(F("Zone invalide.")); return; }
  const uint8_t z = (uint8_t)(numZ - 1);
  ReglagesZone c = ctrl.cfg[z];

  if (v == "autotune") {
    char err[80] = "";
    if (ctrl.lancerAutotune(z, millis(), err, sizeof err))
      Serial.println(F("Autotune lance : la zone va osciller volontairement pendant ~1 h."));
    else
      Serial.printf("Refuse : %s\n", err);
    return;
  }
  if (v == "stop-autotune") { ctrl.arreterAutotune(z); Serial.println(F("Autotune arrete.")); return; }

  if (n < 3) { Serial.println(F("Il manque une valeur. `help`.")); return; }
  const float val = j[2].toFloat();

  if (v == "nom") {
    // Tout ce qui suit le numero de zone, espaces internes compris. Chercher
    // simplement la premiere occurrence du 3e jeton dans la ligne donnait
    // « 1 1 » pour `nom 1 1`, ou « nom 2 nom » pour `nom 2 nom`.
    int p = cmd.indexOf(' ');                                  // fin du mot-cle
    while (p >= 0 && cmd[(unsigned)p] == ' ') p++;             // debut du numero de zone
    p = (p >= 0) ? cmd.indexOf(' ', (unsigned)p) : -1;         // fin du numero de zone
    while (p >= 0 && cmd[(unsigned)p] == ' ') p++;             // debut du texte
    snprintf(c.nom, sizeof c.nom, "%s", (p > 0) ? cmd.substring(p).c_str() : j[2].c_str());
  }
  else if (v == "jour")   c.consigneJour = val;
  else if (v == "nuit")   c.consigneNuit = val;
  else if (v == "bande")  c.bande = val;
  else if (v == "ki")     c.ki = val;
  else if (v == "max")    c.tempMax = val;
  else if (v == "offset") c.offset = val;
  else if (v == "rampe")  c.rampeMinutes = (uint16_t)j[2].toInt();
  else if (v == "derive") { c.deriveSeuil = val; if (n >= 4) c.deriveMinutes = (uint16_t)j[3].toInt(); }
  else if (v == "sanseffet") { c.inefficaceMinutes = (uint16_t)j[2].toInt(); if (n >= 4) c.inefficaceDelta = j[3].toFloat(); }
  else if (v == "chute")     { c.chuteSeuil = val; if (n >= 4) c.chuteSecondes = (uint16_t)j[3].toInt(); }
  else if (v == "heures") {
    if (n < 4) { Serial.println(F("Usage : heures <zone> <HH:MM jour> <HH:MM nuit>")); return; }
    if (!parseHHMM(j[2], c.debutJour) || !parseHHMM(j[3], c.debutNuit)) {
      Serial.println(F("Format d'heure invalide (HH:MM).")); return;
    }
  }
  else { Serial.println(F("Commande inconnue. `help`.")); return; }

  appliquer(z, c);
}

} // namespace

namespace Console {

void aide() {
  Serial.println(F(
    "\nCommandes (z = numero de zone) :\n"
    "  status | stats | version | scan | journal | reseau | help\n"
    "  entretien [min]            coupure temporaire, reprise automatique\n"
    "  entretien-defaut <min>     duree proposee par defaut\n"
    "  alim <amperes> [watts] [volts]  puissance disponible -> zones simultanees\n"
    "  saison <degC> <jDescente> [jPlateau] [jRemontee] | saison off\n"
    "  ecran <minutes>            veille de l'afficheur (0 = jamais)\n"
    "  nom <z> <texte>            renommer la zone\n"
    "  jour <z> <degC>            consigne de jour\n"
    "  nuit <z> <degC>            consigne de nuit\n"
    "  heures <z> <HH:MM> <HH:MM> debut de jour, debut de nuit\n"
    "  rampe <z> <min>            duree de transition jour/nuit\n"
    "  bande <z> <degC>           bande proportionnelle\n"
    "  ki <z> <valeur>            gain integral (par seconde et par degC)\n"
    "  max <z> <degC>             seuil de coupure absolue\n"
    "  offset <z> <degC>          calibration de la sonde\n"
    "  derive <z> <degC> [min]    seuil et delai d'alerte de derive\n"
    "  sanseffet <z> <min> [degC] detection de chauffe sans effet\n"
    "  chute <z> <degC> [s]       chute brutale : seuil et fenetre d'observation\n"
    "  autotune <z> | stop-autotune <z>\n"
    "  lier <index> <z>           associer une sonde du bus a une zone\n"
    "  wifi <ssid> [mdp]          identifiants reseau\n"
    "  motdepasse web <mdp> [user] | motdepasse ota <mdp> | motdepasse ap <mdp>\n"
    "  url alertes <url> | url heartbeat <url>\n"
    "  url jeton <secret|off>     jeton envoye avec les alertes (Bearer)\n"
    "  mqtt <hote|off> [port] [user] [mdp] [tls] | mqtt tls <on|off>\n"
    "  jeton [nouveau]            code d'appairage de cet appareil\n"
    "  reset                      lever les defauts verrouilles\n"
    "  off                        tout couper et verrouiller\n"
    "  effacer-historique | redemarrer\n"));
}

void etat() {
  Serial.printf("\n%s  tapis actif %d  %s  heap %u o\n",
                horodatage().c_str(), ctrl.tapisActif(),
                Reseau::modePointAcces() ? "AP config" : Reseau::adresse().c_str(),
                (unsigned)ESP.getFreeHeap());
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const ZoneEtat &s = ctrl.zone[z];
    Serial.printf("  %-12s %6.2f C -> %5.2f C  demande %3d%%  charge %3.0f%%  I=%+.2f  biais %.2f  %s%s\n",
                  ctrl.cfg[z].nom, s.temperature, s.consigneEff,
                  (int)lroundf(s.demande * 100), ctrl.duty(z), s.integrale, s.biais,
                  nomDefaut(s.defaut),
                  (s.autotune == AT_ATTENTE || s.autotune == AT_OSCILLE) ? "  [autotune]" :
                  (s.deriveActive ? "  [derive]" : ""));
  }
}

void boucle() {
  while (Serial.available()) {
    const char c = (char)Serial.read();
    if (c == '\n' || c == '\r') { const String l = tampon; tampon = ""; traiter(l); }
    else if (tampon.length() < 120) tampon += c;
  }
}

} // namespace Console
