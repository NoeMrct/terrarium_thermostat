# 0005 — Table de partitions sur mesure

Date : septembre 2026. Statut : remplacée par la [décision 0010](0010-repartitionnement.md) en 3.4.0.

## Contexte

Flash de 4 Mo. Le schéma « Default 4MB with spiffs » donne 1,28 Mo par image
d'application : le firmware (1,4 Mo) n'y rentre pas. « Minimal SPIFFS » donne
1,9 Mo par image mais 128 Ko de fichiers : trois jours d'historique.

## Décision

Deux images de **1,5 Mo** (OTA conservée), **896 Ko** de fichiers (une dizaine
de jours d'historique, journal, file d'alertes), **64 Ko** de coredump. La
partition de fichiers s'appelle `spiffs` parce que c'est l'étiquette que
`LittleFS.begin()` cherche par défaut ; son contenu est du LittleFS.

## Conséquences

- 10 % de marge sur l'image : `outils/verifier-taille-firmware.js` fait échouer
  la CI au-delà de 95 %, et la page embarquée est compressée pour en garder.
- Le fichier `partitions.csv` doit être à côté du `.ino` et le schéma « Custom »
  sélectionné dans l'IDE, sinon l'IDE retombe en silence sur 1,25 Mo.
- Le coredump a sa partition : les plantages laissent une trace lisible.
