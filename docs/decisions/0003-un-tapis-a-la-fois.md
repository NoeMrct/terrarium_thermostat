# 0003 — Un seul tapis alimenté à la fois, par construction

Date : août 2026. Statut : adoptée.

## Contexte

Deux tapis de 20 W sous 12 V tirent 3,3 A ensemble ; l'alimentation prévue
fait 3 A. Une régulation classique allumerait les deux dès que les deux zones
réclament.

## Décision

L'exclusion est **structurelle** : une seule fonction écrit les broches de
puissance, elle coupe avant d'allumer, et elle ne peut allumer qu'au plus le
nombre de zones déduit de l'alimentation déclarée (1 pour 3 A, 2 pour 5 A). Le
partage du temps entre zones se fait par créneaux et crédits, proportionnels à
la demande de chaque zone.

## Conséquences

- L'alimentation ne peut pas être surchargée par une erreur d'enchaînement de
  conditions ; le banc d'essai et le fuzzing vérifient l'invariant.
- Une zone attend parfois son tour : la régulation en tient compte (le duty
  cycle visible est celui réellement obtenu).
- Déclarer plus d'ampères que l'alimentation n'en a est le seul moyen de la
  mettre en danger : c'est écrit partout où on saisit cette valeur.
