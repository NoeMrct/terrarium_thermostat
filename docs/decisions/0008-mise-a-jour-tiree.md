# 0008 — Mise à jour tirée par le socle depuis les releases GitHub

Date : octobre 2026. Statut : adoptée.

## Contexte

Jusqu'en 3.3, mettre à jour un socle demandait d'être sur son réseau local :
envoyer le `.bin` à `/api/maj`, ou le câble USB. Un socle chez un acheteur,
derrière une box, ne recevait jamais de correctif de sécurité sans que
quelqu'un passe. Le Cyber Resilience Act attend des mises à jour pendant la
durée de support ; un mécanisme qui dépend de l'utilisateur ne tient pas cette
promesse.

## Décision

Le socle **télécharge lui-même** le binaire, sur ordre (action MQTT `maj`,
commande série `maj`, `/api/maj-distante`) — jamais de sa propre initiative.
L'URL est dérivée de la version (`MAJ_URL_MODELE`, ou `MAJ_URL_MODELE_SIGNE`
quand le socle exige des images signées) ou donnée explicitement, mais ne peut
viser que les releases du dépôt (`MAJ_ORIGINES_AUTORISEES`), en HTTPS avec le
magasin de certificats du cœur ; les redirections de GitHub sont suivies à la
main, cinq au plus, et seulement vers ses serveurs d'objets
(`MAJ_HOTES_AUTORISES`). Le binaire passe par le même chemin que `/api/maj` :
signature ECDSA vérifiée si `OTA_CLE_PUBLIQUE` est renseignée, chauffage coupé
pendant l'écriture, validation après coup et retour arrière automatique
(décision 0007). L'état (`EtatMaj`) est conservé en NVS et publié, pour que
l'application et l'interface disent où en est le socle, y compris après le
redémarrage.

L'application lit la dernière version publiée dans `version.json` (écrit à la
publication à partir de la release) et propose le bouton quand le socle est en
retard.

## Conséquences

- Un correctif se déploie en une action depuis le téléphone, sans câble ni
  accès au réseau local. Le socle reste maître : rien ne s'installe sans ordre.
- La confiance repose sur l'origine, TLS et la signature : sans
  `OTA_CLE_PUBLIQUE`, un attaquant qui détient un code d'appairage *et* peut
  publier une release sur le dépôt installerait un binaire ; la signature ferme
  ce cas. Elle est recommandée en production (`docs/publication.md`).
- Le téléchargement est bloquant (le chien de garde est nourri à chaque bloc) :
  chauffage coupé et régulation suspendue pendant une à deux minutes, puis
  redémarrage. Un socle sans Wi-Fi ou en point d'accès refuse.
- Un fork du projet doit adapter les trois constantes de `config.h` à son
  propre dépôt : rien n'est déduit de l'URL à l'exécution.
