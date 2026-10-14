# 0002 — Appairage par un code secret du socle

Date : septembre 2026. Statut : adoptée.

## Contexte

Sans compte utilisateur, comment une application prouve-t-elle qu'elle a le
droit de piloter un socle, sur un broker éventuellement partagé ?

## Décision

Chaque socle tire au premier démarrage un **code d'appairage** de 24 caractères,
stocké dans sa mémoire, affiché sur son écran (en QR et en lettres), imprimable
en étiquette. Toute commande modifiante doit le porter ; les lectures (état,
statistiques, historique) n'en ont pas besoin. L'identifiant du socle
(`terraXXXXXX`, dérivé de l'adresse MAC) est public : c'est la racine de ses
sujets MQTT.

## Conséquences

- Posséder l'appareil = pouvoir le piloter. Pas de serveur d'authentification.
- Le code circule dans chaque commande : le lien doit être chiffré (l'application
  refuse `ws://` hors développement, le socle parle TLS).
- `jeton nouveau` révoque toutes les applications d'un coup.
- Le code reste sur le téléphone, dans le stockage local du navigateur ; c'est
  dit à l'utilisateur, et l'export de configuration le rappelle.
