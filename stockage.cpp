#include "stockage.h"
#include "anneau.h"
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <esp_random.h>

namespace {

Preferences prefs;
ReglagesReseau g_reseau;
ReglagesGlobaux g_globaux;
bool g_fsPret = false;

const char *CHEMIN_HIST    = "/hist.bin";
const char *CHEMIN_JOURNAL = "/journal.log";
const char *CHEMIN_JOURNAL_PREC = "/journal.1.log";
const char *CHEMIN_ALERTES = "/alertes.txt";

const uint32_t HIST_MAGIC = 0x54455231;   // "TER1"

// Dimensionnement décidé au démarrage d'après la place réellement offerte par
// la partition : un schéma « Minimal SPIFFS » n'expose que 128 Ko, la table sur
// mesure fournie en offre 896 Ko. Figer une capacité en dur remplirait la flash
// dans le premier cas et gaspillerait la place dans le seconde.
uint32_t g_histCapacite = 1440;      // 1 jour, valeur de repli
size_t   g_journalMax   = 16384;

// L'entête ne contient plus d'index mobile : il est écrit une seule fois, à la
// création. La position de la tête est retrouvée au démarrage par recherche
// dichotomique sur les numéros de séquence des enregistrements. Sans cela, il
// fallait réécrire l'entête à chaque échantillon, soit 1440 écritures par jour
// dans le même bloc pour 16 octets utiles.
struct EnTeteHist {
  uint32_t magic;
  uint32_t version;
  uint32_t capacite;
  uint32_t reserve[5];
};

const uint32_t HIST_VERSION = 2;

Anneau g_anneau;
bool   g_histPret = false;

// Adaptateur entre le module d'anneau (qui ne connaît que des emplacements) et
// le fichier réellement ouvert.
bool lireSeqFichier(uint32_t emplacement, uint32_t &seq, void *contexte) {
  File *f = (File *)contexte;
  if (!f || !*f) return false;
  f->seek(sizeof(EnTeteHist) + emplacement * sizeof(Echantillon));
  Echantillon e;
  if (f->read((uint8_t *)&e, sizeof e) != sizeof e) return false;
  seq = e.seq;
  return true;
}

// Ouvre l'anneau et reconstitue son état. Appelée une fois, paresseusement.
File histOuvrir() {
  File f = LittleFS.open(CHEMIN_HIST, "r+");
  EnTeteHist h;
  bool valide = false;
  if (f && f.size() >= sizeof(EnTeteHist)) {
    f.seek(0);
    valide = f.read((uint8_t *)&h, sizeof h) == sizeof h &&
             h.magic == HIST_MAGIC && h.version == HIST_VERSION &&
             h.capacite == g_histCapacite;
  }
  if (!valide) {                       // absent, corrompu, ou capacité changée
    if (f) f.close();
    f = LittleFS.open(CHEMIN_HIST, "w+");
    if (!f) return f;
    memset(&h, 0, sizeof h);
    h.magic = HIST_MAGIC; h.version = HIST_VERSION; h.capacite = g_histCapacite;
    f.seek(0);
    f.write((const uint8_t *)&h, sizeof h);
    f.flush();
    g_anneau.capacite = g_histCapacite;
    anneauVider(g_anneau);
    g_histPret = true;
    return f;
  }
  if (!g_histPret) {
    const uint32_t nb = (uint32_t)((f.size() - sizeof(EnTeteHist)) / sizeof(Echantillon));
    anneauReconstruire(g_anneau, g_histCapacite, nb, lireSeqFichier, &f);
    g_histPret = true;
  }
  return f;
}

void reseauParDefaut(ReglagesReseau &r) {
  memset(&r, 0, sizeof r);
  r.mqttPort = 1883;
  r.heartbeatMinutes = 5;
  snprintf(r.mqttPrefixe, sizeof r.mqttPrefixe, "terrarium");
  snprintf(r.apMotDePasse, sizeof r.apMotDePasse, "terrarium1234");
  snprintf(r.fuseau, sizeof r.fuseau, "CET-1CEST,M3.5.0,M10.5.0/3");
  snprintf(r.ntp, sizeof r.ntp, "fr.pool.ntp.org");
  r.decouverteHA = true;
  // Sortie d'usine, les envois HTTPS et MQTT/TLS doivent authentifier le
  // serveur : sans cela le chiffrement protege du regard mais pas de
  // l'usurpation. A desactiver explicitement pour un certificat auto-signe.
  r.verifierTls = true;
}

// Relecture tolérante des structures de réglages. Règle du projet : ces
// structures ne s'agrandissent QUE par la fin. Un firmware plus récent relit
// alors sans peine une mémoire écrite par l'ancien — les champs ajoutés restent
// à zéro, puis reçoivent leur valeur par défaut. Sans cela, la moindre
// évolution de ReglagesReseau remettait toute la configuration à plat au
// redémarrage : WiFi, mots de passe, et surtout le jeton d'appairage, qui
// aurait été régénéré et aurait dépairé toutes les applications.
// Renvoie le nombre d'octets réellement issus de la mémoire, 0 si rien d'utile.
size_t lireStructure(const char *cle, void *dest, size_t taille) {
  memset(dest, 0, taille);
  const size_t dispo = prefs.getBytesLength(cle);
  if (dispo == 0) return 0;
  if (dispo <= taille) return prefs.getBytes(cle, dest, taille);

  // Écrite par un firmware PLUS récent (retour en arrière) : on ne garde que le
  // préfixe que cette version sait interpréter.
  uint8_t *tampon = (uint8_t *)malloc(dispo);
  if (!tampon) return 0;
  const size_t lu = prefs.getBytes(cle, tampon, dispo);
  if (lu >= taille) memcpy(dest, tampon, taille);
  free(tampon);
  return (lu >= taille) ? taille : 0;
}

// Un champ texte venu de la NVS peut être corrompu : on garantit au minimum
// qu'il reste une chaîne C valide, sinon tout usage ultérieur part en vrille.
void assainirTexte(char *s, size_t taille) {
  s[taille - 1] = '\0';
  for (size_t i = 0; i < taille; i++) {
    if (s[i] == '\0') return;
    if ((unsigned char)s[i] < 32 || (unsigned char)s[i] > 126) { s[i] = '\0'; return; }
  }
}

} // namespace

namespace Stockage {

void reglagesGlobauxParDefaut(ReglagesGlobaux &g) {
  memset(&g, 0, sizeof g);
  g.courantAlimA    = 3.0f;      // le petit adaptateur 12 V d'origine
  g.puissanceTapisW = 20.0f;
  g.tensionV        = 12.0f;
  g.maintenanceMin  = 10;
  g.ecranVeilleMin  = 10;
  g.saisonActive    = false;
  g.saisonDelta     = 5.0f;
  g.saisonDescenteJ = 21;
  g.saisonPlateauJ  = 60;
  g.saisonRemonteeJ = 21;
}

bool globauxValides(const ReglagesGlobaux &g, char *erreur, size_t taille) {
  #define ECHEC(msg) do { if (erreur) snprintf(erreur, taille, msg); return false; } while (0)
  if (!(isfinite(g.courantAlimA) && g.courantAlimA >= 0.5f && g.courantAlimA <= 40.0f))
    ECHEC("Amperage de l'alimentation hors 0.5-40 A");
  if (!(isfinite(g.puissanceTapisW) && g.puissanceTapisW >= 1.0f && g.puissanceTapisW <= 200.0f))
    ECHEC("Puissance d'un tapis hors 1-200 W");
  if (!(isfinite(g.tensionV) && g.tensionV >= 3.0f && g.tensionV <= 60.0f))
    ECHEC("Tension hors 3-60 V");
  if (g.maintenanceMin == 0 || g.maintenanceMin > 240)
    ECHEC("Duree d'entretien hors 1-240 min");
  if (g.ecranVeilleMin > 1440)
    ECHEC("Veille de l'ecran hors 0-1440 min");
  if (!(isfinite(g.saisonDelta) && g.saisonDelta >= 0.0f && g.saisonDelta <= 15.0f))
    ECHEC("Abaissement saisonnier hors 0-15 C");
  if (g.saisonDescenteJ > 365 || g.saisonPlateauJ > 365 || g.saisonRemonteeJ > 365)
    ECHEC("Duree de phase saisonniere hors 0-365 jours");
  if (g.saisonActive && g.saisonDescenteJ + g.saisonPlateauJ + g.saisonRemonteeJ == 0)
    ECHEC("Un cycle saisonnier doit durer au moins un jour");
  #undef ECHEC
  return true;
}

bool assainirGlobaux(ReglagesGlobaux &g) {
  ReglagesGlobaux d; reglagesGlobauxParDefaut(d);
  bool corrige = false;
  #define REPARE(champ, cond) if (!(cond)) { g.champ = d.champ; corrige = true; }
  REPARE(courantAlimA,    isfinite(g.courantAlimA)    && g.courantAlimA    >= 0.5f && g.courantAlimA    <= 40.0f)
  REPARE(puissanceTapisW, isfinite(g.puissanceTapisW) && g.puissanceTapisW >= 1.0f && g.puissanceTapisW <= 200.0f)
  REPARE(tensionV,        isfinite(g.tensionV)        && g.tensionV        >= 3.0f && g.tensionV        <= 60.0f)
  REPARE(maintenanceMin,  g.maintenanceMin >= 1 && g.maintenanceMin <= 240)
  REPARE(ecranVeilleMin,  g.ecranVeilleMin <= 1440)
  REPARE(saisonDelta,     isfinite(g.saisonDelta) && g.saisonDelta >= 0.0f && g.saisonDelta <= 15.0f)
  REPARE(saisonDescenteJ, g.saisonDescenteJ <= 365)
  REPARE(saisonPlateauJ,  g.saisonPlateauJ  <= 365)
  REPARE(saisonRemonteeJ, g.saisonRemonteeJ <= 365)
  #undef REPARE
  if (g.saisonActive && (g.saisonDebutEpoch < 1700000000UL ||
                         g.saisonDescenteJ + g.saisonPlateauJ + g.saisonRemonteeJ == 0)) {
    g.saisonActive = false;                 // cycle indatable : on ne l'applique pas
    corrige = true;
  }
  return corrige;
}

// Combien de zones peuvent chauffer en même temps sans dépasser l'ampérage
// déclaré. Un tapis de 20 W sous 12 V tire 1,7 A : une alimentation de 3 A n'en
// supporte qu'un, une de 5 A en supporte deux.
uint8_t zonesSimultanees(const ReglagesGlobaux &g) {
  const float parTapis = (g.tensionV > 1.0f) ? g.puissanceTapisW / g.tensionV : 1.7f;
  if (parTapis <= 0.01f) return 1;
  // Marge de 20 % : une alimentation annoncée pour 5 A ne les tient pas
  // forcément en continu, et l'électronique consomme aussi.
  int n = (int)((g.courantAlimA * 0.8f) / parTapis);
  if (n < 1) n = 1;
  if (n > NB_ZONES) n = NB_ZONES;
  return (uint8_t)n;
}

float decalageSaisonnier(const ReglagesGlobaux &g, uint32_t maintenantEpoch) {
  if (!g.saisonActive || g.saisonDebutEpoch == 0 || maintenantEpoch < g.saisonDebutEpoch) return 0.0f;
  const uint32_t jours = (maintenantEpoch - g.saisonDebutEpoch) / 86400UL;
  const uint32_t d = g.saisonDescenteJ, p = g.saisonPlateauJ, r = g.saisonRemonteeJ;
  if (d > 0 && jours < d)          return -g.saisonDelta * ((float)jours / d);
  if (jours < d + p)               return -g.saisonDelta;
  if (r > 0 && jours < d + p + r)  return -g.saisonDelta * (1.0f - (float)(jours - d - p) / r);
  return 0.0f;                     // cycle terminé
}

ReglagesGlobaux &globaux() { return g_globaux; }

// Le jeton est tiré du générateur matériel de l'ESP32, pas de rand() : il doit
// être imprévisible, car il vaut preuve de propriété de l'appareil.
void regenererJeton() {
  static const char alphabet[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";  // sans I, O, 0, 1
  for (uint8_t i = 0; i < 24; i++)
    g_reseau.jeton[i] = alphabet[esp_random() % (sizeof(alphabet) - 1)];
  g_reseau.jeton[24] = '\0';
  sauverReseau();
}

bool assurerJeton() {
  bool valide = strlen(g_reseau.jeton) == 24;
  for (uint8_t i = 0; valide && i < 24; i++)
    if (!isalnum((unsigned char)g_reseau.jeton[i])) valide = false;
  if (valide) return false;
  regenererJeton();
  return true;
}

void sauverGlobaux() {
  prefs.begin("thermo", false);
  prefs.putBytes("globaux", &g_globaux, sizeof g_globaux);
  prefs.end();
}

void chargerStats(StatsZone s[NB_ZONES]) {
  prefs.begin("thermo", true);
  lireStructure("stats", s, sizeof(StatsZone) * NB_ZONES);   // remet a zero si absent
  prefs.end();
}

void sauverStats(const StatsZone s[NB_ZONES]) {
  prefs.begin("thermo", false);
  prefs.putBytes("stats", s, sizeof(StatsZone) * NB_ZONES);
  prefs.end();
}

void demarrer() {
  g_fsPret = LittleFS.begin(true);   // true = formate si le montage échoue

  if (g_fsPret) {
    const size_t total = LittleFS.totalBytes();
    // 65 % pour l'historique, 12 % pour le journal, le reste en marge pour la
    // file d'alertes et les métadonnées du système de fichiers.
    g_journalMax = total / 8;
    if (g_journalMax < 8192)  g_journalMax = 8192;
    if (g_journalMax > 65536) g_journalMax = 65536;
    uint32_t cap = (uint32_t)((total * 65 / 100) / sizeof(Echantillon));
    if (cap < 720)   cap = 720;      // 12 h minimum
    if (cap > 20160) cap = 20160;    // 14 jours suffisent largement
    g_histCapacite = cap;
  }

  prefs.begin("thermo", true);
  const size_t lu  = lireStructure("reseau",  &g_reseau,  sizeof g_reseau);
  const size_t luG = lireStructure("globaux", &g_globaux, sizeof g_globaux);
  prefs.end();

  if (luG == 0) reglagesGlobauxParDefaut(g_globaux);
  // Mêmes précautions que pour les zones : une valeur aberrante venue d'une
  // mémoire abîmée ne doit pas pouvoir décider de la puissance appelée. Les
  // bornes vivent dans assainirGlobaux(), à côté de celles de la validation.
  else if (assainirGlobaux(g_globaux))
    journal("Reglages globaux assainis au chargement (valeurs aberrantes corrigees)");
  if (lu == 0) {
    reseauParDefaut(g_reseau);
  } else {
    assainirTexte(g_reseau.ssid, sizeof g_reseau.ssid);
    assainirTexte(g_reseau.motDePasse, sizeof g_reseau.motDePasse);
    assainirTexte(g_reseau.webUtilisateur, sizeof g_reseau.webUtilisateur);
    assainirTexte(g_reseau.webHachage, sizeof g_reseau.webHachage);
    assainirTexte(g_reseau.jeton, sizeof g_reseau.jeton);
    assainirTexte(g_reseau.otaMotDePasse, sizeof g_reseau.otaMotDePasse);
    assainirTexte(g_reseau.apMotDePasse, sizeof g_reseau.apMotDePasse);
    // Le point d'accès de secours est le dernier moyen d'accéder à l'appareil :
    // il ne doit jamais se retrouver ouvert à cause d'une NVS abîmée.
    if (strlen(g_reseau.apMotDePasse) < 8)
      snprintf(g_reseau.apMotDePasse, sizeof g_reseau.apMotDePasse, "terrarium1234");
    assainirTexte(g_reseau.urlAlertes, sizeof g_reseau.urlAlertes);
    assainirTexte(g_reseau.urlHeartbeat, sizeof g_reseau.urlHeartbeat);
    assainirTexte(g_reseau.mqttHote, sizeof g_reseau.mqttHote);
    assainirTexte(g_reseau.mqttUtilisateur, sizeof g_reseau.mqttUtilisateur);
    assainirTexte(g_reseau.mqttMotDePasse, sizeof g_reseau.mqttMotDePasse);
    assainirTexte(g_reseau.mqttPrefixe, sizeof g_reseau.mqttPrefixe);
    assainirTexte(g_reseau.fuseau, sizeof g_reseau.fuseau);
    assainirTexte(g_reseau.ntp, sizeof g_reseau.ntp);
    assainirTexte(g_reseau.alerteJeton, sizeof g_reseau.alerteJeton);
    if (g_reseau.mqttPort == 0) g_reseau.mqttPort = 1883;
    if (g_reseau.heartbeatMinutes == 0 || g_reseau.heartbeatMinutes > 1440) g_reseau.heartbeatMinutes = 5;
    if (g_reseau.mqttPrefixe[0] == '\0') snprintf(g_reseau.mqttPrefixe, sizeof g_reseau.mqttPrefixe, "terrarium");
    if (g_reseau.fuseau[0] == '\0') snprintf(g_reseau.fuseau, sizeof g_reseau.fuseau, "CET-1CEST,M3.5.0,M10.5.0/3");
    if (g_reseau.ntp[0] == '\0') snprintf(g_reseau.ntp, sizeof g_reseau.ntp, "fr.pool.ntp.org");
    // Relecture partielle (mémoire écrite par une version antérieure) : les
    // champs apparus depuis sont à zéro, on leur donne leur valeur d'usine.
    if (lu < sizeof g_reseau) {
      ReglagesReseau d; reseauParDefaut(d);
      if (lu < offsetof(ReglagesReseau, verifierTls) + sizeof(d.verifierTls))
        g_reseau.verifierTls = d.verifierTls;
      if (lu < offsetof(ReglagesReseau, alerteJeton))
        memcpy(g_reseau.alerteJeton, d.alerteJeton, sizeof d.alerteJeton);
      journal("Reglages reseau relus depuis une version anterieure (%u octets sur %u) : "
              "configuration conservee, champs nouveaux mis aux valeurs d'usine",
              (unsigned)lu, (unsigned)sizeof g_reseau);
    }
  }
}

bool systemeFichiersPret() { return g_fsPret; }

ReglagesReseau &reseau() { return g_reseau; }

void sauverReseau() {
  prefs.begin("thermo", false);
  prefs.putBytes("reseau", &g_reseau, sizeof g_reseau);
  prefs.end();
}

// --- réglages de zones ------------------------------------------------------
void chargerZones(ReglagesZone cfg[NB_ZONES], String &rapport) {
  bool aReecrire[NB_ZONES] = { false, false };
  prefs.begin("thermo", true);
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    char cle[8];
    snprintf(cle, sizeof cle, "zone%u", z);
    const size_t lu = lireStructure(cle, &cfg[z], sizeof(ReglagesZone));
    if (lu == 0) {
      reglagesParDefaut(cfg[z], z);
      rapport += "zone " + String(z + 1) + " : reglages absents, valeurs par defaut. ";
      aReecrire[z] = true;
      continue;
    }
    // Une NVS corrompue ne doit jamais pouvoir appliquer une consigne aberrante.
    char details[160] = "";
    if (assainirReglages(cfg[z], z, details, sizeof details)) {
      rapport += "zone " + String(z + 1) + " : champs corriges (" + details + "). ";
      aReecrire[z] = true;
    }
  }
  prefs.end();

  // Réécrire la version assainie : sinon la valeur aberrante reste en mémoire
  // non volatile et se fait re-corriger, re-journaliser, à chaque démarrage.
  for (uint8_t z = 0; z < NB_ZONES; z++) if (aReecrire[z]) sauverZone(z, cfg[z]);
}

void sauverZone(uint8_t z, const ReglagesZone &r) {
  if (z >= NB_ZONES) return;
  char cle[8];
  snprintf(cle, sizeof cle, "zone%u", z);
  prefs.begin("thermo", false);
  prefs.putBytes(cle, &r, sizeof r);
  prefs.end();
}

// --- défauts ---------------------------------------------------------------
void chargerDefauts(uint8_t d[NB_ZONES]) {
  prefs.begin("thermo", true);
  if (prefs.getBytes("defauts", d, NB_ZONES) != NB_ZONES)
    for (uint8_t z = 0; z < NB_ZONES; z++) d[z] = DEF_AUCUN;
  prefs.end();
  for (uint8_t z = 0; z < NB_ZONES; z++) if (d[z] > DEF_INEFFICACE) d[z] = DEF_AUCUN;
}

void sauverDefauts(const uint8_t d[NB_ZONES]) {
  prefs.begin("thermo", false);
  prefs.putBytes("defauts", d, NB_ZONES);
  prefs.end();
}

// --- biais appris ----------------------------------------------------------
float lireBiais(uint8_t z) {
  char cle[8]; snprintf(cle, sizeof cle, "bi%u", z);
  prefs.begin("thermo", true);
  const float v = prefs.getFloat(cle, 0.0f);
  prefs.end();
  return (isfinite(v) && v >= 0.0f && v <= 1.0f) ? v : 0.0f;
}

void sauverBiais(uint8_t z, float b) {
  if (!isfinite(b)) return;
  char cle[8]; snprintf(cle, sizeof cle, "bi%u", z);
  prefs.begin("thermo", false);
  prefs.putFloat(cle, b);
  prefs.end();
}

// --- horloge de secours ----------------------------------------------------
uint32_t lireEpoch() {
  prefs.begin("thermo", true);
  const uint32_t e = prefs.getUInt("epoch", 0);
  prefs.end();
  return e;
}

void sauverEpoch(uint32_t e) {
  prefs.begin("thermo", false);
  prefs.putUInt("epoch", e);
  prefs.end();
}

// --- historique ------------------------------------------------------------
void histAjouter(const Echantillon &e) {
  if (!g_fsPret) return;
  File f = histOuvrir();
  if (!f) return;
  Echantillon copie = e;
  copie.seq = g_anneau.seq;
  f.seek(sizeof(EnTeteHist) + anneauEmplacementEcriture(g_anneau) * sizeof(Echantillon));
  if (f.write((const uint8_t *)&copie, sizeof copie) == sizeof copie) anneauAvancer(g_anneau);
  f.close();
}

uint32_t histNombre() {
  if (!g_fsPret) return 0;
  if (!g_histPret) { File f = histOuvrir(); if (f) f.close(); }
  return g_anneau.remplis;
}

uint32_t histCapacite() { return g_histCapacite; }

// Le fichier reste ouvert pendant tout le parcours : l'export complet ouvrait
// auparavant LittleFS une fois par point, soit plusieurs milliers d'ouvertures.
void histParcourir(uint32_t rangDebut, uint32_t pas, VisiteurHist visiteur, void *contexte) {
  if (!g_fsPret || !visiteur || pas == 0) return;
  File f = histOuvrir();
  if (!f) return;
  Echantillon e;
  uint32_t emplacement = 0;
  for (uint32_t rang = rangDebut; anneauEmplacementDuRang(g_anneau, rang, emplacement); rang += pas) {
    f.seek(sizeof(EnTeteHist) + emplacement * sizeof(Echantillon));
    if (f.read((uint8_t *)&e, sizeof e) != sizeof e) break;
    if (!visiteur(e, contexte)) break;
  }
  f.close();
}

void histEffacer() {
  if (!g_fsPret) return;
  LittleFS.remove(CHEMIN_HIST);
  anneauVider(g_anneau);
  g_histPret = false;
}

// --- journal ---------------------------------------------------------------
void journalAjouter(const String &ligne) {
  if (!g_fsPret) return;
  File f = LittleFS.open(CHEMIN_JOURNAL, "a");
  if (!f) return;
  if (f.size() > g_journalMax) {         // rotation : on garde une génération
    f.close();
    LittleFS.remove(CHEMIN_JOURNAL_PREC);
    LittleFS.rename(CHEMIN_JOURNAL, CHEMIN_JOURNAL_PREC);
    f = LittleFS.open(CHEMIN_JOURNAL, "a");
    if (!f) return;
  }
  f.println(ligne);
  f.close();
}

String journalQueue(size_t maxOctets) {
  if (!g_fsPret) return String("(systeme de fichiers indisponible)");
  File f = LittleFS.open(CHEMIN_JOURNAL, "r");
  if (!f) return String("(journal vide)");
  const size_t taille = f.size();
  if (taille > maxOctets) f.seek(taille - maxOctets);
  String s;
  s.reserve(taille > maxOctets ? maxOctets : taille);
  while (f.available()) s += (char)f.read();
  f.close();
  return s;
}

void journalEffacer() {
  if (!g_fsPret) return;
  LittleFS.remove(CHEMIN_JOURNAL);
  LittleFS.remove(CHEMIN_JOURNAL_PREC);
}

// --- file d'alertes --------------------------------------------------------
// Persistée : une coupure réseau de plusieurs heures ne doit pas faire perdre
// l'alerte qui explique justement ce qui s'est passé.
void alerteEmpiler(const String &texte) {
  if (!g_fsPret) return;
  File f = LittleFS.open(CHEMIN_ALERTES, "a");
  if (!f) return;
  if (f.size() < 8192) {              // garde-fou : on ne remplit pas la flash
    String l = texte;
    l.replace('\n', ' ');
    f.println(l);
  }
  f.close();
}

bool alerteTete(String &texte) {
  if (!g_fsPret) return false;
  File f = LittleFS.open(CHEMIN_ALERTES, "r");
  if (!f) return false;
  texte = f.readStringUntil('\n');
  f.close();
  texte.trim();
  return texte.length() > 0;
}

void alerteDefiler() {
  if (!g_fsPret) return;
  File f = LittleFS.open(CHEMIN_ALERTES, "r");
  if (!f) return;
  f.readStringUntil('\n');
  String reste;
  reste.reserve(f.available() + 1);
  while (f.available()) reste += (char)f.read();
  f.close();
  if (reste.length() == 0) { LittleFS.remove(CHEMIN_ALERTES); return; }
  File g = LittleFS.open(CHEMIN_ALERTES, "w");
  if (!g) return;
  g.print(reste);
  g.close();
}

uint16_t alertesEnAttente() {
  if (!g_fsPret) return 0;
  File f = LittleFS.open(CHEMIN_ALERTES, "r");
  if (!f) return 0;
  uint16_t n = 0;
  while (f.available()) if (f.read() == '\n') n++;
  f.close();
  return n;
}

} // namespace Stockage
