# 0010 — Repartitionnement : 1,69 Mo par image, 512 Ko de fichiers

Date : octobre 2026. Statut : adoptée. Remplace la décision 0005.

## Contexte

La table de la décision 0005 (2 × 1,5 Mo d'application, 896 Ko de fichiers)
était taillée pour un firmware de 1,4 Mo. En 3.3, le binaire occupait 91 % de
son emplacement ; la 3.4 ajoute TLS pour le téléchargement, mDNS, le portail
captif, Improv, les sessions. Au-delà de 95 %, le garde-fou de taille bloque la
CI, et à 100 % plus aucune mise à jour OTA ne passe : le projet aurait été
figé.

## Décision

**2 × 0x1B0000 (1,69 Mo)** pour les images, **0x80000 (512 Ko)** de fichiers,
coredump inchangé. L'historique garde un point par minute sur ≈ 11 jours (65 %
de la partition, 20 octets par point), largement au-delà des 24 h que
l'application lit au socle — les durées plus longues viennent de l'historique
local de l'application ou du serveur (décision 0009).

Un socle déjà en service **garde son ancienne table** tant qu'il n'est pas
reflashé par USB : une mise à jour OTA n'écrit que l'image. Le garde-fou
(`outils/verifier-taille-firmware.js`) vérifie donc le binaire contre **les
deux** emplacements, et `partitions.csv` documente les deux générations.

## Conséquences

- 81 % d'occupation en 3.4 : de la marge pour plusieurs versions ; la limite
  des socles non reflashés (1,5 Mo) reste la contrainte réelle tant qu'il en
  existe, et la CI échoue avant qu'un binaire ne la dépasse.
- Un reflashage par USB avec effacement complet est nécessaire pour profiter de
  la nouvelle table ; la page « Flasher un socle » le propose, le code
  d'appairage et les réglages sont alors à ressaisir (ou à réimporter depuis
  une sauvegarde).
- Les offsets de `partitions.csv` sont compilés dans `partitions.bin` et
  distribués avec chaque release : un outil externe qui flashe doit prendre la
  table de la même version.
