# 0006 — Publication MQTT sur changement, protocole versionné

Date : octobre 2026. Statut : adoptée.

## Contexte

Le socle publiait l'état de chaque zone toutes les 20 s, quoi qu'il arrive :
lent pour l'utilisateur qui vient de changer une consigne, coûteux sur un
broker facturé au trafic, et muet sur ce qui ne figure pas dans l'état
(signal, mémoire, redémarrages).

## Décision

Chaque zone est republiée **dès que ce qu'on affiche change** (température au
vingtième de degré, consigne, demande, tapis, défaut…), au plus toutes les 2 s,
et de toute façon toutes les 60 s. Un sujet `sante` retenu porte ce qui
concerne l'appareil. Un numéro de **version de protocole** (`proto`) est
publié : l'application sait dire qui, d'elle ou du socle, est en retard. Les
commandes portent un identifiant et sont **rejouées sans effet** : le QoS 1
devient sûr.

## Conséquences

- L'application réagit en deux secondes, le trafic baisse de cinq à dix fois.
- Un socle « en ligne » qui n'a rien publié depuis plus de deux minutes est
  signalé **silencieux** : le testament du broker ne suffit pas à distinguer un
  socle vivant d'un socle coincé.
- Tout changement de contrat incrémente `PROTO_VERSION` ; `protocole.schema.json`
  est vérifié par la CI sur tout ce que le socle émet.
