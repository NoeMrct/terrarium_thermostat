# 0001 — Le client ne possède pas le broker

Date : septembre 2026. Statut : adoptée.

## Contexte

Le pilotage à distance passe par MQTT. Trois façons de fournir le broker : le
client l'héberge (un Raspberry chez lui), le vendeur l'héberge pour tous
(managé : HiveMQ Starter, plancher d'environ 250 $ par mois ; ou auto-hébergé),
ou un service tiers gratuit que le client choisit (HiveMQ Cloud Serverless,
100 connexions).

## Décision

Le socle **fonctionne en local sans compte ni abonnement** : écran, interface
web locale, régulation. Le suivi à distance est une **option** qui passe par un
broker que le socle et l'application savent joindre, en TLS, avec des
identifiants par socle. Au lancement, le client crée son compte HiveMQ gratuit
en suivant la procédure ; plus tard, un broker opéré par le vendeur devient une
option payante qui finance l'infrastructure.

## Conséquences

- Aucune dépendance à un serveur à nous pour que le produit marche : pas de
  panne de service, pas d'abonnement obligatoire, pas de données chez nous.
- Le firmware accepte n'importe quel broker à certificat public (magasin
  d'autorités du cœur ESP32) : rien à recompiler pour en changer.
- La procédure de création de compte HiveMQ est une étape de plus à la mise en
  service, documentée pas à pas (document « Mise en service »).
- Le code d'appairage est le seul secret partagé socle ↔ application : il
  protège contre un broker mal cloisonné (voir 0002).
