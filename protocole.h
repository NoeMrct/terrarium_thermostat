/* =============================================================================
   protocole.h — CANAL DE COMMANDE (MQTT <prefixe>/<id>/cmd → /reponse)
   -----------------------------------------------------------------------------
   Sans dépendance Arduino : l'analyse d'une commande JSON, la vérification du
   jeton, les bornes, la mémoire des réponses récentes (commandes rejouées sans
   effet) vivent ici, et tournent à l'identique dans le firmware et sur PC —
   où sim/test-protocole.cpp les vérifie et sim/fuzz.cpp les malmène avec des
   charges arbitraires. C'est la surface d'attaque exposée au broker : elle est
   testée contre le vrai code, pas contre une maquette.

   Ce dont le canal a besoin du reste du firmware passe par l'interface Socle :
   reseau.cpp l'implémente sur la carte, les bancs d'essai la simulent.
   ============================================================================= */
#ifndef PROTOCOLE_H
#define PROTOCOLE_H

#include <stdint.h>
#include <stddef.h>
#include "controle.h"
#include "reglages.h"
#include "majauto.h"

namespace Protocole {

// Taille maximale d'un corps de réponse : l'historique compacté (120 points de
// cinq nombres) est le plus gros, et doit tenir sous le tampon MQTT de 8 Ko.
const size_t TAILLE_CORPS = 7000;
const size_t TAILLE_REPONSE = TAILLE_CORPS + 96;

// Accès support (V11). Le propriétaire ouvre une session par une commande
// « service » signée avec le code d'appairage : il y donne une clé aléatoire
// (64 caractères hexadécimaux), que l'application remet au serveur. Tant que
// la session vaut, une commande signée avec cette clé est acceptée comme celle
// du propriétaire — sauf l'ouverture d'une autre session. Le code d'appairage,
// lui, ne quitte jamais le téléphone. La session tient 1 à 168 h et se
// prolonge au plus jusqu'à 7 jours après son ouverture ; elle exige une heure
// fiable (NTP), sans quoi aucune commande du support n'est acceptée.
struct SessionService {
  char cle[65];     // vide : aucune session
  uint32_t ouvert;  // epoch d'ouverture
  uint32_t jusqua;  // epoch de fin
};
const uint32_t SERVICE_MAX_S = 7UL * 86400UL;

class Socle {
public:
  virtual ~Socle() {}
  // Secret de l'appareil : exigé pour toute action modifiante.
  virtual const char *jeton() = 0;
  // Publie une réponse complète ({"req":…,"ok":…,…}) sur <base>/reponse.
  virtual void repondre(const char *json) = 0;
  // Corps (sans accolades) des lectures : "\"version\":\"…\",\"proto\":N", etc.
  virtual void corpsVersion(char *out, size_t taille) = 0;
  virtual void corpsEtat(char *out, size_t taille) = 0;
  virtual void corpsStats(char *out, size_t taille) = 0;
  // decalage : heures sautées au plus récent (fenêtre plus ancienne, par pages).
  virtual void corpsHistorique(uint32_t heures, uint16_t maxi, uint32_t decalage, char *out,
                               size_t taille) = 0;
  virtual void corpsGlobaux(char *out, size_t taille) = 0;
  // Réglages.
  virtual ReglagesZone &zone(uint8_t z) = 0;
  virtual void sauverZone(uint8_t z) = 0;  // persiste zone(z), journalise, republie
  virtual ReglagesGlobaux &globaux() = 0;
  virtual void sauverGlobaux() = 0;  // persiste globaux(), applique
  // Plages horaires (F5), action « programme ».
  virtual Programme &programme() = 0;
  virtual void sauverProgramme() = 0;  // persiste programme(), l'applique à la régulation, republie
  virtual bool heureFiable() = 0;
  virtual uint32_t epoch() = 0;
  virtual uint8_t limiteZones() = 0;
  // Actions.
  virtual void leverDefauts() = 0;
  virtual void entretien(uint16_t minutes) = 0;
  virtual bool lancerAutotune(uint8_t z, char *erreur, size_t taille) = 0;
  virtual void arreterAutotune(uint8_t z) = 0;
  virtual void effacerHistorique() = 0;
  virtual void redemarrer() = 0;
  // Mise à jour tirée. Le canal vérifie la version visée (anti-retour,
  // MajAuto::cibleAcceptable) contre versionFirmware() ; majAcceptable() ajoute
  // ce que seul le socle sait (hôte autorisé, en ligne), puis lancerMaj() — qui
  // ne revient pas sur la carte si l'image est acceptée. `forcer` : réinstaller
  // la même version, jamais une plus ancienne.
  virtual const char *versionFirmware() = 0;
  virtual bool majAcceptable(const char *url, const char *version, bool forcer, char *erreur,
                             size_t taille) = 0;
  virtual void lancerMaj(const char *cible, bool forcer) = 0;
  // Mises à jour automatiques (F15) : état ("majAuto":{…}), lecture du
  // manifeste demandée pour le prochain tour de boucle, report (NVS).
  virtual void corpsMajAuto(char *out, size_t taille) = 0;
  virtual void verifierMaj() = 0;
  virtual MajAuto::Etat &etatMajAuto() = 0;
  virtual void sauverEtatMajAuto() = 0;
  virtual void journal(const char *texte) = 0;

  // Protocole 4 (F1) : à distance, ce que seule la page locale savait faire.
  // Les corps s'écrivent comme corpsEtat : des champs JSON sans accolades.
  virtual void corpsSondes(bool relire, char *out, size_t taille) = 0;  // "sondes":{…}
  virtual bool lierSonde(uint8_t z, const char *rom, char *message, size_t taille) = 0;
  virtual bool identifierSonde(uint8_t z, char *message, size_t taille) = 0;
  virtual void annulerIdentification() = 0;
  virtual bool lancerEssai(uint8_t z, char *message, size_t taille) = 0;
  virtual void annulerEssai() = 0;
  virtual void corpsEssai(char *out, size_t taille) = 0;  // "essai":{…}
  virtual bool calibrer(char *message, size_t taille) = 0;
  virtual void corpsRapport(char *out, size_t taille) = 0;  // "texte":"…"
  virtual void envoyerRapport() = 0;
  virtual void corpsJours(uint16_t n, uint16_t depuis, char *out, size_t taille) = 0;  // "jours":{…}
  virtual void corpsJournal(char *out, size_t taille) = 0;     // "texte":"…" (la fin)
  virtual void corpsSauvegarde(char *out, size_t taille) = 0;  // "sauvegarde":{…}
  virtual bool restaurer(const char *json, size_t n, char *message, size_t taille) = 0;
  virtual ReglagesReseau &reseau() = 0;
  virtual void sauverReseau() = 0;
  virtual void alerteEssai() = 0;  // une alerte de test, par le chemin des vraies (F18)

  // Accès support : la session, gardée par le socle (NVS) ; sauverService()
  // la persiste et met l'écran à jour (« Support connecté »).
  virtual SessionService &service() = 0;
  virtual void sauverService() = 0;

  // Fin d'atelier (3.5.1, action « expedier ») : l'identifiant du socle, que
  // la commande doit redire, et ce qu'il montre une fois prêt à partir (écran,
  // LED) jusqu'à son débranchement. Vrai si un écran l'affiche.
  virtual const char *identifiant() = 0;
  virtual bool montrerExpedition() = 0;
};

// Une session d'accès support est ouverte et n'a pas expiré (heure fiable).
bool serviceActif(Socle &socle);

// Traite une charge reçue sur <base>/cmd. Toujours une réponse, même pour du
// JSON invalide (req vide alors).
void traiterCommande(Socle &socle, const char *charge, size_t taille);

// Mémoire des réponses récentes : une requête déjà vue reçoit la même réponse
// sans être rejouée. Vidée par les bancs d'essai entre deux scénarios.
void oublierReponses();

// Une action qui se lit sans jeton (etat, stats, version, historique).
bool actionLectureSeule(const char *action);

// Plages horaires en JSON, sans accolades :
// "actif":…,"weekend":…,"semaine":[{"debut":480,"nom":"Matin","consignes":[30.0,27.0]},…],"weekEnd":[…]
void corpsProgramme(const Programme &p, char *out, size_t taille);
// Relit ce même JSON (avec accolades) par-dessus `p` : seuls les champs
// présents changent, chaque jeu donné est remplacé en entier. N'applique
// rien et ne valide pas les consignes (voir programmeValide).
bool lireProgramme(const char *json, size_t n, Programme &p, char *erreur, size_t taille);

}  // namespace Protocole

#endif  // PROTOCOLE_H
