# 0004 — Un client MQTT écrit pour l'application

Date : octobre 2026. Statut : adoptée.

## Contexte

MQTT.js pesait 369 Ko (111 Ko compressés), soit quatre fois le reste de
l'application, pour un usage réduit : se connecter en WebSocket, s'abonner,
publier, rester en vie, se reconnecter.

## Décision

`app/mqtt.js`, environ 300 lignes, MQTT 3.1.1 sur WebSocket : CONNECT,
SUBSCRIBE, PUBLISH QoS 0 et 1 avec réémission, réception QoS 1 et 2 acquittée,
keepalive, reconnexion à délai croissant. Même interface que MQTT.js pour ce
sous-ensemble, pour que le harnais de test et la démonstration n'en sachent
rien. Pas de QoS 2 en émission, pas de sessions persistantes, pas de MQTT 5.

## Conséquences

- L'application entière pèse moins qu'une photo ; le budget de poids le garantit.
- Le client est testé face à un vrai broker (16 vérifications : encodage,
  longueurs multi-octets, keepalive, reconnexion, refus, QoS 1 rejoué).
- Toute fonctionnalité MQTT nouvelle s'écrit ici, pas dans une bibliothèque.
