# 0007 — Mises à jour validées après coup, retour arrière automatique

Date : octobre 2026. Statut : adoptée.

## Contexte

Une mise à jour qui démarre puis plante laissait un socle inutilisable jusqu'à
un reflashage par câble — et un terrarium sans régulation. Le cœur ESP32 marque
par défaut une image comme valide dès son premier démarrage.

## Décision

Le firmware demande au cœur de **ne pas valider** l'image au démarrage
(`verifyRollbackLater`) et la valide lui-même après **90 s** de fonctionnement
normal. Une image qui plante avant n'est jamais confirmée : au redémarrage
suivant, le chargeur relance la version précédente, et le journal, les alertes
et l'interface le disent. En complément, les images envoyées par `/api/maj`
peuvent être exigées **signées** (ECDSA P-256, clé publique compilée).

## Conséquences

- Une mauvaise release se corrige d'elle-même sur les socles installés, sans
  intervention ; la régulation reprend sur l'ancienne version.
- 90 s pendant lesquels une coupure de courant ferait aussi revenir en arrière :
  acceptable, la mise à jour se refait.
- La signature protège contre un firmware étranger installé par le réseau ; elle
  ne protège pas contre un accès USB (voir `docs/securisation-serie.md`).
