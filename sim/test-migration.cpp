/* Banc d'essai de la migration des réglages persistés : une mémoire NVS écrite
   par un firmware 3.2 (ou 3.3) doit être relue par le firmware courant sans
   rien perdre — WiFi, mots de passe et surtout le jeton d'appairage, dont la
   régénération dépairerait toutes les applications. La règle « on n'ajoute
   qu'en fin de structure » est vérifiée à la compilation (offsets figés) et à
   l'exécution (relecture d'une image 3.2 octet par octet).

     make migration */
#include "../reglages.h"
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <cmath>

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

// ReglagesReseau telle que le firmware 3.2.0 l'écrivait (jusqu'à sondeRom).
// Ne JAMAIS modifier : c'est l'image de référence des socles déjà en service.
struct ReglagesReseau32 {
  char ssid[33];
  char motDePasse[65];
  char webUtilisateur[17];
  char webHachage[65];
  bool verifierTls;
  char otaMotDePasse[33];
  char apMotDePasse[33];
  char urlAlertes[161];
  char urlHeartbeat[161];
  uint16_t heartbeatMinutes;
  char mqttHote[65];
  uint16_t mqttPort;
  char mqttUtilisateur[33];
  char mqttMotDePasse[65];
  char mqttPrefixe[33];
  bool mqttActif;
  bool mqttTls;
  bool decouverteHA;
  char jeton[25];
  char fuseau[48];
  char ntp[49];
  uint8_t sondeRom[NB_ZONES][8];
};

// Dispositions figées. Si l'une de ces lignes casse, un champ a été inséré au
// milieu d'une structure persistée : les socles en service perdraient leurs
// réglages à la mise à jour. Ajouter en fin, et figer la nouvelle taille ici.
static_assert(sizeof(ReglagesReseau32) == 912, "image 3.2 de ReglagesReseau");
static_assert(offsetof(ReglagesReseau, alerteJeton) == 912, "3.3 ajoute alerteJeton en fin de l'image 3.2");
static_assert(offsetof(ReglagesReseau, formatAlertes) == 977, "formatAlertes suit alerteJeton");
static_assert(sizeof(ReglagesReseau) == 978, "taille de ReglagesReseau en 3.4");
static_assert(offsetof(ReglagesReseau, jeton) == offsetof(ReglagesReseau32, jeton), "le jeton ne bouge pas");
static_assert(offsetof(ReglagesReseau, sondeRom) == offsetof(ReglagesReseau32, sondeRom),
              "les sondes liées ne bougent pas");
static_assert(sizeof(ReglagesGlobaux) == 36, "taille de ReglagesGlobaux");
static_assert(sizeof(EtatMaj) == 97, "taille de EtatMaj");
static_assert(sizeof(StatsZone) == 16, "taille de StatsZone");
static_assert(sizeof(ReglagesZone) == 72, "taille de ReglagesZone");

int main() {
  printf("=== Migration des réglages persistés ===\n");

  // Une mémoire écrite par 3.2, remplie de valeurs reconnaissables.
  ReglagesReseau32 ancienne;
  memset(&ancienne, 0, sizeof ancienne);
  snprintf(ancienne.ssid, sizeof ancienne.ssid, "Maison");
  snprintf(ancienne.motDePasse, sizeof ancienne.motDePasse, "mot-de-passe-wifi");
  snprintf(ancienne.webUtilisateur, sizeof ancienne.webUtilisateur, "admin");
  snprintf(ancienne.mqttHote, sizeof ancienne.mqttHote,
           "203822f8cc7741d596f7897376bcce75.s1.eu.hivemq.cloud");
  ancienne.mqttPort = 8883;
  ancienne.mqttTls = true;
  ancienne.verifierTls = true;
  snprintf(ancienne.mqttPrefixe, sizeof ancienne.mqttPrefixe, "terrarium");
  snprintf(ancienne.jeton, sizeof ancienne.jeton, "ABCDEFGHIJKLMNOPQRSTUVWX");
  snprintf(ancienne.fuseau, sizeof ancienne.fuseau, "CET-1CEST,M3.5.0,M10.5.0/3");
  for (uint8_t z = 0; z < NB_ZONES; z++)
    for (uint8_t i = 0; i < 8; i++) ancienne.sondeRom[z][i] = (uint8_t)(0x28 + z * 16 + i);

  ReglagesReseau courante;
  memset(&courante, 0xA5, sizeof courante);  // sale avant relecture
  const size_t lu = Stockage::relireTolerant((const uint8_t *)&ancienne, sizeof ancienne, &courante,
                                             sizeof courante);
  VERIFIE(lu == sizeof ancienne, "une image 3.2 est relue en entier");
  VERIFIE(strcmp(courante.ssid, "Maison") == 0 && strcmp(courante.motDePasse, "mot-de-passe-wifi") == 0,
          "SSID et mot de passe WiFi conservés");
  VERIFIE(strcmp(courante.jeton, "ABCDEFGHIJKLMNOPQRSTUVWX") == 0,
          "jeton d'appairage conservé (sinon toutes les applications seraient dépairées)");
  VERIFIE(courante.mqttPort == 8883 && courante.mqttTls && courante.verifierTls &&
              strcmp(courante.mqttPrefixe, "terrarium") == 0,
          "broker, port, TLS et préfixe conservés");
  VERIFIE(memcmp(courante.sondeRom, ancienne.sondeRom, sizeof ancienne.sondeRom) == 0,
          "sondes liées conservées");
  VERIFIE(courante.alerteJeton[0] == '\0' && courante.formatAlertes == 0,
          "champs ajoutés depuis : à zéro (puis valeur par défaut au démarrage)");

  // Une mémoire écrite par un firmware PLUS récent (retour en arrière) : on ne
  // garde que le préfixe que cette version connaît.
  uint8_t future[sizeof(ReglagesReseau) + 40];
  memset(future, 0, sizeof future);
  memcpy(future, &courante, sizeof courante);
  memset(future + sizeof courante, 0xEE, 40);
  ReglagesReseau relue;
  const size_t lu2 = Stockage::relireTolerant(future, sizeof future, &relue, sizeof relue);
  VERIFIE(lu2 == sizeof relue && memcmp(&relue, &courante, sizeof relue) == 0,
          "image plus récente : le préfixe connu est relu, le reste ignoré");

  // Rien d'exploitable.
  ReglagesReseau vide;
  VERIFIE(Stockage::relireTolerant(nullptr, 0, &vide, sizeof vide) == 0 && vide.ssid[0] == '\0',
          "mémoire absente : structure à zéro, 0 octet");
  VERIFIE(Stockage::relireTolerant(future, 0, &vide, sizeof vide) == 0, "longueur nulle : 0 octet");

  // Réglages globaux : même règle, mêmes effets.
  ReglagesGlobaux g;
  Stockage::reglagesGlobauxParDefaut(g);
  g.courantAlimA = 5.0f;
  ReglagesGlobaux g2;
  const size_t lg = Stockage::relireTolerant((const uint8_t *)&g, sizeof g - 4, &g2,
                                             sizeof g2);  // écrite sans saisonDebutEpoch
  VERIFIE(lg == sizeof g - 4 && g2.courantAlimA == 5.0f && g2.saisonDebutEpoch == 0,
          "globaux écrits par une version sans le dernier champ : relus, dernier champ à zéro");
  VERIFIE(!Stockage::assainirGlobaux(g2), "…et jugés sains tels quels");
  g2.courantAlimA = 1e9f;
  VERIFIE(Stockage::assainirGlobaux(g2) && g2.courantAlimA == 3.0f,
          "une valeur aberrante est ramenée à la valeur par défaut");

  // Règles des réglages globaux : puissance disponible et cycle saisonnier.
  ReglagesGlobaux r;
  Stockage::reglagesGlobauxParDefaut(r);
  VERIFIE(Stockage::zonesSimultanees(r) == 1, "3 A, tapis 20 W sous 12 V : une seule zone à la fois");
  r.courantAlimA = 5.0f;
  VERIFIE(Stockage::zonesSimultanees(r) == 2, "5 A : deux zones (marge de 20 % comprise)");
  r.courantAlimA = 40.0f;
  VERIFIE(Stockage::zonesSimultanees(r) == NB_ZONES, "40 A : plafonné au nombre de zones");
  r.tensionV = 0.5f;
  VERIFIE(Stockage::zonesSimultanees(r) >= 1,
          "tension absurde : au moins une zone, pas de division par zéro");
  Stockage::reglagesGlobauxParDefaut(r);
  r.saisonActive = true;
  r.saisonDelta = 4.0f;
  r.saisonDescenteJ = 10;
  r.saisonPlateauJ = 20;
  r.saisonRemonteeJ = 10;
  r.saisonDebutEpoch = 1700000000u;
  const uint32_t J = 86400u;
  VERIFIE(Stockage::decalageSaisonnier(r, r.saisonDebutEpoch - 1) == 0.0f,
          "saison : avant le début, aucun décalage");
  VERIFIE(fabsf(Stockage::decalageSaisonnier(r, r.saisonDebutEpoch + 5 * J) + 2.0f) < 1e-4f,
          "saison : à mi-descente, la moitié de l'abaissement");
  VERIFIE(fabsf(Stockage::decalageSaisonnier(r, r.saisonDebutEpoch + 20 * J) + 4.0f) < 1e-4f,
          "saison : sur le plateau, l'abaissement entier");
  VERIFIE(fabsf(Stockage::decalageSaisonnier(r, r.saisonDebutEpoch + 35 * J) + 2.0f) < 1e-4f,
          "saison : à mi-remontée, la moitié");
  VERIFIE(Stockage::decalageSaisonnier(r, r.saisonDebutEpoch + 41 * J) == 0.0f,
          "saison : cycle terminé, retour à zéro");
  r.saisonActive = false;
  VERIFIE(Stockage::decalageSaisonnier(r, r.saisonDebutEpoch + 20 * J) == 0.0f, "saison inactive : zéro");
  r.saisonActive = true;
  r.saisonDescenteJ = r.saisonPlateauJ = r.saisonRemonteeJ = 0;
  char err[100];
  VERIFIE(!Stockage::globauxValides(r, err, sizeof err) && strstr(err, "au moins un jour"),
          "un cycle de zéro jour est refusé");
  VERIFIE(Stockage::assainirGlobaux(r) && !r.saisonActive, "…et désactivé à l'assainissement");
  r.saisonDescenteJ = 400;
  VERIFIE(!Stockage::globauxValides(r, nullptr, 0), "phase de 400 jours refusée (sans tampon d'erreur)");
  VERIFIE(strcmp(nomEtapeMaj(MAJ_VALIDEE), "validee") == 0 &&
              strcmp(nomEtapeMaj(MAJ_RETOUR_ARRIERE), "retour arriere") == 0 &&
              strcmp(nomEtapeMaj(MAJ_ECHEC), "echec") == 0 &&
              strcmp(nomEtapeMaj(MAJ_EN_VALIDATION), "en validation") == 0 &&
              strcmp(nomEtapeMaj(42), "aucune") == 0,
          "noms des étapes de mise à jour");

  printf("\n=== %s : %d/%d ===\n", g_echecs ? "ECHEC" : "MIGRATION OK", g_total - g_echecs, g_total);
  return g_echecs ? 1 : 0;
}
