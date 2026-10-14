# 0009 — Un serveur auto-hébergé en option, jamais obligatoire

Date : octobre 2026. Statut : adoptée. Complète la décision 0001.

## Contexte

La décision 0001 (le client ne possède pas le broker) et la 0002 (appairage
par un code secret) donnent un produit qui fonctionne sans aucun service à
nous. Elles laissent trois manques qu'un broker nu ne comble pas : un
identifiant de broker partagé commande tous les socles d'un même compte
HiveMQ ; l'historique n'existe que quand l'application est ouverte ; une
alerte n'atteint un téléphone, application fermée, qu'en passant par un
service tiers (ntfy) configuré sur chaque socle. Un acheteur qui veut
simplement « être prévenu sur son téléphone » n'a rien de clé en main.

## Décision

Le dépôt fournit un **serveur** (`serveur/`) : un seul processus Node, sans
base de données, qui embarque un broker MQTT (aedes) avec des **comptes** et
des **droits par socle**, garde un **historique** continu, envoie des
notifications **Web Push** et reçoit les rapports de diagnostic. Il est
**auto-hébergé** et **facultatif** : l'application le détecte (`/api/infos`)
et s'adapte, mais tout fonctionne sans lui, et aucun exemplaire n'est exploité
par le projet. Un socle est rattaché à un compte uniquement par la **preuve de
son code d'appairage** : le serveur interroge le socle (`globaux`) avec le code
fourni et n'accorde les droits que s'il répond — le code reste le seul secret,
le compte ne fait que le porter (décision 0002 inchangée). Les socles
peuvent rester sur un broker amont (HiveMQ) que le serveur **pont**.

## Conséquences

- Le produit reste utilisable sans compte, sans serveur et sans abonnement ;
  le serveur ajoute le confort pour qui l'installe (ou pour un revendeur qui en
  exploite un pour ses clients, auquel cas il en porte la responsabilité RGPD —
  voir `app/confidentialite.html` et `docs/conformite.md`).
- Un seul processus et des fichiers plats (comptes `scrypt`, historique
  NDJSON) : trivial à sauvegarder, à migrer, à lire ; pas de base à
  administrer. Au-delà de quelques centaines de socles, il faudrait repenser
  l'historique.
- Les droits sont appliqués par le broker lui-même (publication interdite →
  déconnexion, abonnement interdit → SUBACK 128) : un client ne voit jamais les
  sujets d'un socle qui n'est pas à lui, quoi qu'il demande.
- Le serveur double une partie du protocole (sessions, revendication, push) :
  `outils/test-serveur.js` rejoue le parcours complet application ↔ serveur ↔
  socle simulé pour que les deux ne divergent pas.
