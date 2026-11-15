#include "sauvegarde.h"
#include "liaisons.h"
#include "protocole.h"
#include "reseau.h"
#include "sondes.h"
#include "stockage.h"
#include <ArduinoJson.h>

namespace {

const char *FORMAT = "terrarium-sauvegarde";

void copier(char *dest, size_t taille, JsonVariantConst v) {
  if (v.is<const char *>()) snprintf(dest, taille, "%s", v.as<const char *>());
}

}  // namespace

namespace Sauvegarde {

String json(bool pourLeBroker) {
  JsonDocument d;
  d["format"] = FORMAT;
  d["version"] = FW_VERSION;
  d["appareil"] = Reseau::identifiant();
  d["date"] = horodatage();
  JsonArray zones = d["zones"].to<JsonArray>();
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const ReglagesZone &c = ctrl.cfg[z];
    JsonObject o = zones.add<JsonObject>();
    o["nom"] = c.nom;
    o["consigneJour"] = c.consigneJour;
    o["consigneNuit"] = c.consigneNuit;
    o["bande"] = c.bande;
    o["ki"] = c.ki;
    o["tempMax"] = c.tempMax;
    o["offset"] = c.offset;
    o["debutJour"] = c.debutJour;
    o["debutNuit"] = c.debutNuit;
    o["rampeMinutes"] = c.rampeMinutes;
    o["inefficaceMinutes"] = c.inefficaceMinutes;
    o["inefficaceDelta"] = c.inefficaceDelta;
    o["deriveSeuil"] = c.deriveSeuil;
    o["deriveMinutes"] = c.deriveMinutes;
    o["chuteSeuil"] = c.chuteSeuil;
    o["chuteSecondes"] = c.chuteSecondes;
  }
  const ReglagesGlobaux &g = Stockage::globaux();
  JsonObject o = d["globaux"].to<JsonObject>();
  o["courantAlimA"] = g.courantAlimA;
  o["puissanceTapisW"] = g.puissanceTapisW;
  o["tensionV"] = g.tensionV;
  o["maintenanceMin"] = g.maintenanceMin;
  o["ecranVeilleMin"] = g.ecranVeilleMin;
  o["saisonActive"] = g.saisonActive;
  o["saisonDelta"] = g.saisonDelta;
  o["saisonDescenteJ"] = g.saisonDescenteJ;
  o["saisonPlateauJ"] = g.saisonPlateauJ;
  o["saisonRemonteeJ"] = g.saisonRemonteeJ;
  o["saisonDebutEpoch"] = g.saisonDebutEpoch;
  o["rapportActif"] = g.rapportActif;
  o["rapportMinutes"] = g.rapportMinutes;
  o["prixKwh"] = g.prixKwh;
  o["ledEteinte"] = g.ledEteinte;
  o["ecranNuit"] = g.ecranNuit;
  o["soleilActif"] = g.soleilActif;
  o["soleilDecalageMin"] = g.soleilDecalageMin;
  o["latitude"] = g.latitude;
  o["longitude"] = g.longitude;
  o["zonePrioritaire"] = g.zonePrioritaire;
  // Préchauffage et saisons du calendrier ; des vacances, seulement la façon
  // de les vivre : leurs dates ne valent que pour ce socle, cette fois-là.
  o["prechauffage"] = g.prechauffage;
  o["saisonsActives"] = g.saisonsActives;
  o["hiverDebut"] = g.hiverDebut;
  o["hiverFin"] = g.hiverFin;
  o["hiverDecalage"] = g.hiverDecalage;
  o["hiverRaccourciMin"] = g.hiverRaccourciMin;
  o["saisonTransitionJ"] = g.saisonTransitionJ;
  o["vacancesDecalage"] = g.vacancesDecalage;
  o["vacancesAlertes"] = g.vacancesAlertes;
  // Plages horaires (F5), au format du canal de commande.
  static char programme[1100];
  programme[0] = '{';
  Protocole::corpsProgramme(ctrl.prog, programme + 1, sizeof programme - 2);
  strcat(programme, "}");
  d["programme"] = serialized(programme);
  JsonArray sondes = d["sondes"].to<JsonArray>();
  const ReglagesReseau &r = Stockage::reseau();
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    char t[20] = "";
    if (!Liaisons::romNulle(r.sondeRom[z])) Liaisons::romTexte(r.sondeRom[z], t, sizeof t);
    sondes.add(t);
  }
  JsonObject n = d["reseau"].to<JsonObject>();
  n["fuseau"] = r.fuseau;
  n["ntp"] = r.ntp;
  if (!pourLeBroker) {
    n["urlAlertes"] = r.urlAlertes;  // une URL ntfy vaut secret : à garder pour soi
    n["urlHeartbeat"] = r.urlHeartbeat;
  }
  n["formatAlertes"] = r.formatAlertes;
  n["heartbeatMinutes"] = r.heartbeatMinutes;
  n["mqttPrefixe"] = r.mqttPrefixe;
  n["decouverteHA"] = r.decouverteHA;
  String s;
  if (pourLeBroker)
    serializeJson(d, s);
  else
    serializeJsonPretty(d, s);
  return s;
}

bool restaurer(const char *texte, size_t longueur, char *message, size_t taille) {
  JsonDocument d;
  if (deserializeJson(d, texte, longueur) != DeserializationError::Ok) {
    snprintf(message, taille, "Fichier illisible (JSON invalide)");
    return false;
  }
  if (!(d["format"] == FORMAT)) {
    snprintf(message, taille, "Ce n'est pas une sauvegarde de socle");
    return false;
  }

  // Tout est préparé sur des copies, validé, et seulement ensuite appliqué.
  ReglagesZone zones[NB_ZONES];
  JsonArrayConst za = d["zones"];
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    zones[z] = ctrl.cfg[z];
    JsonObjectConst o = za[z];
    if (o.isNull()) continue;
    ReglagesZone &c = zones[z];
    copier(c.nom, sizeof c.nom, o["nom"]);
    c.consigneJour = o["consigneJour"] | c.consigneJour;
    c.consigneNuit = o["consigneNuit"] | c.consigneNuit;
    c.bande = o["bande"] | c.bande;
    c.ki = o["ki"] | c.ki;
    c.tempMax = o["tempMax"] | c.tempMax;
    c.offset = o["offset"] | c.offset;
    c.debutJour = o["debutJour"] | c.debutJour;
    c.debutNuit = o["debutNuit"] | c.debutNuit;
    c.rampeMinutes = o["rampeMinutes"] | c.rampeMinutes;
    c.inefficaceMinutes = o["inefficaceMinutes"] | c.inefficaceMinutes;
    c.inefficaceDelta = o["inefficaceDelta"] | c.inefficaceDelta;
    c.deriveSeuil = o["deriveSeuil"] | c.deriveSeuil;
    c.deriveMinutes = o["deriveMinutes"] | c.deriveMinutes;
    c.chuteSeuil = o["chuteSeuil"] | c.chuteSeuil;
    c.chuteSecondes = o["chuteSecondes"] | c.chuteSecondes;
    char erreur[100];
    if (!reglagesValides(c, erreur, sizeof erreur)) {
      snprintf(message, taille, "Zone %u refusee : %s. Rien n'a ete applique", z + 1, erreur);
      return false;
    }
  }

  ReglagesGlobaux g = Stockage::globaux();
  JsonObjectConst o = d["globaux"];
  if (!o.isNull()) {
    g.courantAlimA = o["courantAlimA"] | g.courantAlimA;
    g.puissanceTapisW = o["puissanceTapisW"] | g.puissanceTapisW;
    g.tensionV = o["tensionV"] | g.tensionV;
    g.maintenanceMin = o["maintenanceMin"] | g.maintenanceMin;
    g.ecranVeilleMin = o["ecranVeilleMin"] | g.ecranVeilleMin;
    g.saisonActive = o["saisonActive"] | g.saisonActive;
    g.saisonDelta = o["saisonDelta"] | g.saisonDelta;
    g.saisonDescenteJ = o["saisonDescenteJ"] | g.saisonDescenteJ;
    g.saisonPlateauJ = o["saisonPlateauJ"] | g.saisonPlateauJ;
    g.saisonRemonteeJ = o["saisonRemonteeJ"] | g.saisonRemonteeJ;
    g.saisonDebutEpoch = o["saisonDebutEpoch"] | g.saisonDebutEpoch;
    g.rapportActif = o["rapportActif"] | g.rapportActif;
    g.rapportMinutes = o["rapportMinutes"] | g.rapportMinutes;
    g.prixKwh = o["prixKwh"] | g.prixKwh;
    g.ledEteinte = o["ledEteinte"] | g.ledEteinte;
    g.ecranNuit = o["ecranNuit"] | g.ecranNuit;
    g.soleilActif = o["soleilActif"] | g.soleilActif;
    g.soleilDecalageMin = o["soleilDecalageMin"] | g.soleilDecalageMin;
    g.latitude = o["latitude"] | g.latitude;
    g.longitude = o["longitude"] | g.longitude;
    g.zonePrioritaire = o["zonePrioritaire"] | g.zonePrioritaire;
    g.prechauffage = o["prechauffage"] | g.prechauffage;
    g.saisonsActives = o["saisonsActives"] | g.saisonsActives;
    g.hiverDebut = o["hiverDebut"] | g.hiverDebut;
    g.hiverFin = o["hiverFin"] | g.hiverFin;
    g.hiverDecalage = o["hiverDecalage"] | g.hiverDecalage;
    g.hiverRaccourciMin = o["hiverRaccourciMin"] | g.hiverRaccourciMin;
    g.saisonTransitionJ = o["saisonTransitionJ"] | g.saisonTransitionJ;
    g.vacancesDecalage = o["vacancesDecalage"] | g.vacancesDecalage;
    g.vacancesAlertes = o["vacancesAlertes"] | g.vacancesAlertes;
    char erreur[100];
    if (!Stockage::globauxValides(g, erreur, sizeof erreur)) {
      snprintf(message, taille, "Reglages generaux refuses : %s. Rien n'a ete applique", erreur);
      return false;
    }
  }

  Programme prog = ctrl.prog;
  JsonVariantConst pv = d["programme"];
  if (!pv.isNull()) {
    String texte;
    serializeJson(pv, texte);
    char erreur[100];
    if (!Protocole::lireProgramme(texte.c_str(), texte.length(), prog, erreur, sizeof erreur) ||
        !programmeValide(prog, zones, erreur, sizeof erreur)) {
      snprintf(message, taille, "Plages refusees : %s. Rien n'a ete applique", erreur);
      return false;
    }
  }

  uint8_t roms[NB_ZONES][8];
  memcpy(roms, Stockage::reseau().sondeRom, sizeof roms);
  JsonArrayConst sa = d["sondes"];
  if (!sa.isNull()) {
    memset(roms, 0, sizeof roms);
    for (uint8_t z = 0; z < NB_ZONES; z++) {
      const char *t = sa[z] | "";
      uint8_t rom[8];
      if (t[0] && !Liaisons::romDepuisTexte(t, rom)) {
        snprintf(message, taille, "Adresse de sonde illisible pour la zone %u. Rien n'a ete applique", z + 1);
        return false;
      }
      if (t[0]) Liaisons::lier(roms, rom, z);  // une sonde ne vaut que pour une zone
    }
  }

  // Validé : on applique.
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    ctrl.cfg[z] = zones[z];
    Stockage::sauverZone(z, zones[z]);
  }
  Stockage::globaux() = g;
  Stockage::sauverGlobaux();
  ctrl.prog = prog;
  Stockage::sauverProgramme(prog);
  ReglagesReseau &r = Stockage::reseau();
  memcpy(r.sondeRom, roms, sizeof roms);
  JsonObjectConst n = d["reseau"];
  if (!n.isNull()) {
    copier(r.fuseau, sizeof r.fuseau, n["fuseau"]);
    copier(r.ntp, sizeof r.ntp, n["ntp"]);
    copier(r.urlAlertes, sizeof r.urlAlertes, n["urlAlertes"]);
    copier(r.urlHeartbeat, sizeof r.urlHeartbeat, n["urlHeartbeat"]);
    copier(r.mqttPrefixe, sizeof r.mqttPrefixe, n["mqttPrefixe"]);
    r.formatAlertes = n["formatAlertes"] | r.formatAlertes;
    r.heartbeatMinutes = n["heartbeatMinutes"] | r.heartbeatMinutes;
    r.decouverteHA = n["decouverteHA"] | r.decouverteHA;
  }
  Stockage::sauverReseau();
  Sondes::rechargerLiaisons();
  appliquerReglagesGlobaux();
  ctrl.oublierMesures();
  const char *source = d["appareil"] | "?";
  snprintf(message, taille,
           "Configuration de %s restauree (zones, plages, reglages, sondes, alertes). Ressaisir le Wi-Fi et "
           "MQTT si "
           "besoin, "
           "puis redemarrer pour le fuseau.",
           source);
  journal("%s", message);
  return true;
}

}  // namespace Sauvegarde
