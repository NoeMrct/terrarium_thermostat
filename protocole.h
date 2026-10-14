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

namespace Protocole {

// Taille maximale d'un corps de réponse : l'historique compacté (120 points de
// cinq nombres) est le plus gros, et doit tenir sous le tampon MQTT de 8 Ko.
const size_t TAILLE_CORPS = 7000;
const size_t TAILLE_REPONSE = TAILLE_CORPS + 96;

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
  virtual void corpsHistorique(uint32_t heures, uint16_t maxi, char *out, size_t taille) = 0;
  virtual void corpsGlobaux(char *out, size_t taille) = 0;
  // Réglages.
  virtual ReglagesZone &zone(uint8_t z) = 0;
  virtual void sauverZone(uint8_t z) = 0;  // persiste zone(z), journalise, republie
  virtual ReglagesGlobaux &globaux() = 0;
  virtual void sauverGlobaux() = 0;  // persiste globaux(), applique
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
  // Mise à jour tirée : validation de la cible (hôte autorisé, version
  // plausible, pas déjà installée), puis lancement — qui ne revient pas sur
  // la carte si l'image est acceptée.
  virtual bool majAcceptable(const char *url, const char *version, bool forcer, char *erreur,
                             size_t taille) = 0;
  virtual void lancerMaj(const char *cible) = 0;
  virtual void journal(const char *texte) = 0;
};

// Traite une charge reçue sur <base>/cmd. Toujours une réponse, même pour du
// JSON invalide (req vide alors).
void traiterCommande(Socle &socle, const char *charge, size_t taille);

// Mémoire des réponses récentes : une requête déjà vue reçoit la même réponse
// sans être rejouée. Vidée par les bancs d'essai entre deux scénarios.
void oublierReponses();

// Une action qui se lit sans jeton (etat, stats, version, historique).
bool actionLectureSeule(const char *action);

}  // namespace Protocole

#endif  // PROTOCOLE_H
