/* Socle factice pour exercer protocole.cpp sur PC : deux zones aux réglages par
   défaut, des réglages globaux par défaut, et un journal de ce que le canal de
   commande a demandé (réponses publiées, actions déclenchées). Partagé par le
   banc d'essai (test-protocole.cpp) et le fuzzer (fuzz.cpp). */
#ifndef SOCLE_FACTICE_H
#define SOCLE_FACTICE_H

#include "../protocole.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

struct SocleFactice : public Protocole::Socle {
  ReglagesZone zones[NB_ZONES];
  ReglagesGlobaux glob;
  std::vector<std::string> reponses;
  std::vector<std::string> actions;
  std::string jetonSecret = "SIMULATIONTESTJETON00001";
  bool heure = true;
  bool enLigne = true;
  bool autotuneRefuse = false;
  int zonesSauvees = 0, globauxSauves = 0;

  SocleFactice() {
    for (uint8_t z = 0; z < NB_ZONES; z++) reglagesParDefaut(zones[z], z);
    Stockage::reglagesGlobauxParDefaut(glob);
  }
  void vider() {
    reponses.clear();
    actions.clear();
  }
  const std::string &derniere() const {
    static const std::string vide;
    return reponses.empty() ? vide : reponses.back();
  }

  const char *jeton() override { return jetonSecret.c_str(); }
  void repondre(const char *json) override { reponses.push_back(json); }
  void corpsVersion(char *out, size_t taille) override {
    snprintf(out, taille, "\"version\":\"9.9.9\",\"compile\":\"banc\",\"proto\":3");
  }
  void corpsEtat(char *out, size_t taille) override {
    snprintf(out, taille,
             "\"zones\":[{\"nom\":\"%s\",\"temp\":30.00},{\"nom\":\"%s\",\"temp\":24.00}],\"uptime\":1,"
             "\"proto\":3",
             zones[0].nom, zones[1].nom);
  }
  void corpsStats(char *out, size_t taille) override { snprintf(out, taille, "\"zones\":[]"); }
  void corpsHistorique(uint32_t heures, uint16_t maxi, char *out, size_t taille) override {
    snprintf(out, taille, "\"heures\":%u,\"n\":%u,\"points\":[]", (unsigned)heures, (unsigned)maxi);
  }
  void corpsGlobaux(char *out, size_t taille) override {
    snprintf(out, taille,
             "\"amperes\":%.1f,\"watts\":%.0f,\"volts\":%.1f,\"zonesSimultanees\":%u,\"entretienMin\":%u",
             (double)glob.courantAlimA, (double)glob.puissanceTapisW, (double)glob.tensionV,
             (unsigned)Stockage::zonesSimultanees(glob), (unsigned)glob.maintenanceMin);
  }
  ReglagesZone &zone(uint8_t z) override { return zones[z]; }
  void sauverZone(uint8_t z) override {
    zonesSauvees++;
    actions.push_back("sauverZone " + std::to_string(z));
  }
  ReglagesGlobaux &globaux() override { return glob; }
  void sauverGlobaux() override {
    globauxSauves++;
    actions.push_back("sauverGlobaux");
  }
  bool heureFiable() override { return heure; }
  uint32_t epoch() override { return 1760000000u; }
  uint8_t limiteZones() override { return Stockage::zonesSimultanees(glob); }
  void leverDefauts() override { actions.push_back("leverDefauts"); }
  void entretien(uint16_t minutes) override { actions.push_back("entretien " + std::to_string(minutes)); }
  bool lancerAutotune(uint8_t z, char *erreur, size_t taille) override {
    if (autotuneRefuse) {
      snprintf(erreur, taille, "sonde en defaut");
      return false;
    }
    actions.push_back("autotune " + std::to_string(z));
    return true;
  }
  void arreterAutotune(uint8_t z) override { actions.push_back("stop-autotune " + std::to_string(z)); }
  void effacerHistorique() override { actions.push_back("effacerHistorique"); }
  void redemarrer() override { actions.push_back("redemarrer"); }
  bool majAcceptable(const char *url, const char *version, bool forcer, char *erreur,
                     size_t taille) override {
    if (version[0] && strcmp(version, "9.9.9") == 0 && !forcer) {
      snprintf(erreur, taille, "deja en 9.9.9");
      return false;
    }
    if (url[0] && strncmp(url, "https://github.com/", 19) != 0) {
      snprintf(erreur, taille, "hote non autorise");
      return false;
    }
    if (!enLigne) {
      snprintf(erreur, taille, "hors ligne");
      return false;
    }
    return true;
  }
  void lancerMaj(const char *cible) override { actions.push_back(std::string("maj ") + cible); }
  void journal(const char *texte) override { actions.push_back(std::string("journal ") + texte); }
};

#endif
