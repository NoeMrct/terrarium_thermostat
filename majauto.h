/* =============================================================================
   majauto.h — MISES À JOUR : VERSIONS, IMAGES, DÉPLOIEMENT, DÉCISION
   -----------------------------------------------------------------------------
   Sans dépendance Arduino, vérifié sur PC (sim/test-majauto.cpp) et malmené par
   sim/fuzz.cpp : ce qui décide si une image peut remplacer le firmware, et quand
   le socle installe de lui-même une version publiée.

     - Versions X.Y.Z comparées nombre par nombre : jamais de retour à une
       version plus ancienne par les chemins distants (anti-retour, S4).
     - En-tête d'une image ESP32 : la version et le projet que le firmware y
       inscrit (descripteur d'application, version_image.cpp), lus avant
       d'écrire le moindre octet en flash.
     - Remorque de signature des images (outils/signer-firmware.js).
     - Manifeste terrarium-version.json publié avec chaque release : version,
       résumé, correctif de sécurité, déploiement progressif (V9).
     - La décision d'installer seul (F15) : activée par défaut, la nuit dans une
       plage réglable, jamais pendant un défaut, un autotune, un essai, un
       entretien ou un accès support ; une tentative par nuit, trois au plus par
       version ; jamais une version déjà revenue en arrière sur ce socle ; et
       seulement quand les images signées sont exigées (clé compilée).
   ============================================================================= */
#ifndef MAJAUTO_H
#define MAJAUTO_H

#include <stddef.h>
#include <stdint.h>

namespace MajAuto {

// --- versions ---------------------------------------------------------------
// « 3.5.0 » : trois nombres de 0 à 65535 séparés par des points, rien d'autre.
bool versionValide(const char *v);
// <0, 0 ou >0. Une version invalide vaut moins que n'importe quelle valide.
int comparerVersions(const char *a, const char *b);
// Version d'une URL de release, « …/releases/download/v3.6.0/… » → « 3.6.0 ».
bool versionDepuisUrl(const char *url, char *version, size_t taille);

// Avant tout téléchargement (commande « maj », console, page) : la version
// visée, donnée telle quelle ou lue dans l'étiquette de l'URL, n'est ni plus
// ancienne que `courante`, ni la même sans `forcer`. Une URL sans étiquette
// lisible passe : l'en-tête de l'image tranchera avant l'écriture.
bool cibleAcceptable(const char *url, const char *version, const char *courante, bool forcer, char *erreur,
                     size_t taille);

// --- en-tête d'une image ----------------------------------------------------
// Octets à lire avant de décider : en-tête de 24 octets, en-tête du premier
// segment (8), puis le descripteur d'application, version en 0x30 et nom du
// projet en 0x50 (32 octets chacun).
const size_t TAILLE_ENTETE_IMAGE = 0x70;
#define MAJAUTO_PROJET "terrarium_thermostat"
// true : image ESP32 (magie 0xE9) qui porte un descripteur d'application
// (magie 0xABCD5432). Version et projet en sortent, vides s'ils ne sont pas
// imprimables. false : autre chose, ou moins de TAILLE_ENTETE_IMAGE octets.
bool lireEnteteImage(const uint8_t *b, size_t n, char *version, size_t tailleVersion, char *projet,
                     size_t tailleProjet);

// Une image de `version` et `projet` peut-elle remplacer `courante` ?
// Par défaut seule une version plus récente de ce firmware passe. `memeAutorisee`
// (« forcer ») admet de réinstaller la même ; `retourAutorise` (page locale,
// case cochée par le propriétaire) admet tout, version ancienne ou inconnue.
bool imageAcceptable(const char *version, const char *projet, const char *courante, bool memeAutorisee,
                     bool retourAutorise, char *erreur, size_t taille);

// --- remorque de signature --------------------------------------------------
// <image><signature DER><2 octets : longueur, petit-boutiste><"TERRASIG">.
// Sur les `n` derniers octets du flux : la longueur de la signature (8 à 80),
// ou 0 et la raison du refus.
size_t lireRemorque(const uint8_t *fin, size_t n, const char **raison);
const size_t REMORQUE_MAX = 80 + 10;

// --- manifeste --------------------------------------------------------------
struct Manifeste {
  char version[16];
  char notes[192];  // résumé de la version, coupé proprement (UTF-8)
  bool securite;    // correctif de sécurité
  uint32_t debut;   // epoch d'ouverture du déploiement (0 : ouvert à tous)
  uint8_t jours;    // montée en charge en jours + 1 paliers (0 : tous d'un coup)
  bool pause;       // déploiement suspendu par le mainteneur
};
// {"version":"3.6.0","notes":"…","securite":false,
//  "deploiement":{"debut":1763596800,"jours":7,"pause":false}}
// Champs inconnus ignorés ; sans version valide, la lecture échoue.
bool lireManifeste(const char *json, size_t taille, Manifeste &m, char *erreur, size_t tailleErreur);

// --- déploiement progressif (V9) --------------------------------------------
// Rang stable du socle, de 0 à 99, tiré de son identifiant (FNV-1a).
uint8_t rang(const char *id);
// Part des socles servie : (jour + 1) / (jours + 1), le jour 0 étant celui de
// l'ouverture. 0 avant l'ouverture ou en pause, 100 au bout de `jours` jours.
uint8_t pourcentageOuvert(const Manifeste &m, uint32_t maintenant);

// --- plage horaire ----------------------------------------------------------
// [debut, fin) en minutes depuis minuit ; fin < debut passe minuit.
bool dansPlage(uint16_t minutes, uint16_t debut, uint16_t fin);
const uint16_t PLAGE_DEBUT_DEFAUT = 3 * 60;
const uint16_t PLAGE_FIN_DEFAUT = 5 * 60;

// --- état persistant (NVS « majauto ») --------------------------------------
// TOUT AJOUT SE FAIT EN FIN DE STRUCTURE (relecture tolérante).
struct Etat {
  uint32_t reporteeJusqua;     // epoch ; 0 : pas de report
  uint32_t derniereTentative;  // epoch de la dernière installation lancée seule
  uint8_t essais;              // tentatives ratées pour versionEssayee
  char versionEssayee[16];     // en cours d'installation automatique
  char versionRefusee[16];     // revenue en arrière ici : jamais réinstallée seule
  char versionAnnoncee[16];    // dernière version annoncée au propriétaire
};
const uint8_t ESSAIS_MAX = 3;
const uint32_t ENTRE_TENTATIVES_S = 20UL * 3600UL;  // une tentative par nuit
const uint32_t DEMARRAGE_MIN_S = 600;               // 10 min de fonctionnement d'abord
const uint8_t REPORT_MAX_J = 30;

// Ce que le socle sait de lui-même au moment de décider.
struct Contexte {
  const char *courante;  // FW_VERSION
  const char *id;        // identifiant (rang de déploiement)
  bool actif;            // mises à jour automatiques (activées par défaut)
  bool signee;           // clé publique compilée : images signées exigées
  uint16_t plageDebut, plageFin;
  bool heureFiable;
  uint32_t epoch;
  uint16_t minutesLocales;
  bool enLigne;
  uint32_t uptimeS;
  bool validation;  // l'image qui tourne n'est pas encore validée
  bool defaut, autotune, essai, entretien, support;
};

// Pourquoi on n'installe pas (encore). L'ordre est celui des vérifications.
enum Attente : uint8_t {
  PRETE = 0,    // installer maintenant
  A_JOUR,       // rien de plus récent
  REFUSEE,      // cette version est revenue en arrière sur ce socle
  DESACTIVEE,   // mises à jour automatiques coupées par le propriétaire
  NON_SIGNEE,   // aucune clé compilée : installation manuelle seulement
  ECHECS,       // ESSAIS_MAX tentatives ratées pour cette version
  HEURE,        // heure inconnue
  REPORTEE,     // reportée par le propriétaire
  PAUSE,        // déploiement suspendu
  DEPLOIEMENT,  // pas encore le tour de ce socle
  TENTEE,       // déjà tentée cette nuit
  PLAGE,        // hors de la plage horaire
  HORS_LIGNE,
  DEMARRAGE,   // démarré depuis moins de DEMARRAGE_MIN_S
  VALIDATION,  // l'image courante attend encore sa validation
  DEFAUT,
  AUTOTUNE,
  ESSAI,
  ENTRETIEN,
  SUPPORT
};
Attente decider(const Contexte &c, const Manifeste &m, const Etat &e);
const char *codeAttente(Attente a);   // mot-clé stable (JSON) : "prete", "plage"…
const char *texteAttente(Attente a);  // en clair (console, journal)

// Nouvelle version jamais annoncée sur ce socle (et pas déjà refusée).
bool aAnnoncer(const Contexte &c, const Manifeste &m, const Etat &e);
void noterAnnonce(Etat &e, const Manifeste &m);
// Une installation automatique est lancée : compte la tentative.
void noterTentative(Etat &e, const char *version, uint32_t maintenant);
// L'image `version` est revenue en arrière : plus d'installation automatique.
void noterRetourArriere(Etat &e, const char *version);
// L'image qui tourne vient d'être validée : true si c'était une installation
// automatique (à annoncer comme réussie) ; les compteurs repartent à zéro.
bool noterValidation(Etat &e, const char *courante);
// Report de `jours` (1 à REPORT_MAX_J) ; 0 annule. false hors bornes.
bool reporter(Etat &e, uint32_t maintenant, long jours);

}  // namespace MajAuto

#endif  // MAJAUTO_H
