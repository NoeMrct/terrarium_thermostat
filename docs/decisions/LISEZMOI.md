# Décisions d'architecture

Une page par décision qui a façonné le projet : le contexte, ce qui a été
choisi, ce que ça coûte. Le format est celui des *architecture decision
records* : court, daté, jamais réécrit — une décision changée donne une nouvelle
page qui remplace l'ancienne.

| N° | Décision |
|---|---|
| [0001](0001-broker.md) | Le client ne possède pas le broker : local sans compte, distance en option |
| [0002](0002-appairage.md) | Appairage par un code secret du socle, jamais par un compte |
| [0003](0003-un-tapis-a-la-fois.md) | Un seul tapis alimenté à la fois, par construction |
| [0004](0004-client-mqtt-maison.md) | Un client MQTT écrit pour l'application plutôt que MQTT.js |
| [0005](0005-partitions.md) | Table de partitions sur mesure : 1,5 Mo par image, 896 Ko de fichiers |
| [0006](0006-publication-sur-changement.md) | Publication MQTT sur changement, et protocole versionné |
| [0007](0007-retour-arriere-ota.md) | Mises à jour validées après coup, retour arrière automatique |
| [0008](0008-mise-a-jour-tiree.md) | Mise à jour tirée par le socle depuis les releases GitHub |
| [0009](0009-serveur-optionnel.md) | Un serveur auto-hébergé en option, jamais obligatoire |
| [0010](0010-repartitionnement.md) | Repartitionnement : 1,69 Mo par image, 512 Ko de fichiers (remplace 0005) |
