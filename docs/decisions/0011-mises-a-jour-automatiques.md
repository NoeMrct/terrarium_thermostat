# 0011 — Mises à jour automatiques signées, la nuit, en déploiement progressif

Date : novembre 2026. Statut : adoptée. Remplace en partie 0008 (« jamais de
sa propre initiative »).

## Contexte

Avec la mise à jour tirée (0008), un correctif n'atteint un socle que si son
propriétaire appuie sur le bouton. Le Cyber Resilience Act (annexe I, partie I,
2 c) attend des mises à jour de sécurité **automatiques, activées par défaut**,
que l'utilisateur peut désactiver ou reporter, et qui lui sont annoncées. Un
socle chauffe un animal vivant : installer seul ne doit jamais tomber au mauvais
moment, ni installer une image qui ne vient pas de nous, ni pousser d'un coup à
tout le parc une version qui casse quelque chose.

## Décision

- **Un manifeste par release**, `terrarium-version.json`, écrit par le workflow
  de publication (version, résumé, correctif de sécurité, tailles et empreintes,
  déploiement). Le socle le lit chaque jour à l'adresse stable
  `…/releases/latest/download/terrarium-version.json` (`MAJ_MANIFESTE`) : pas
  de serveur à nous, pas de domaine à choisir, et GitHub ne fait jamais
  pointer « latest » vers une pré-version. Les redirections suivent la même
  liste d'hôtes que les images.
- **Installation seule seulement avec des images signées** (clé compilée,
  S5) : sans elle, le socle annonce et attend un geste du propriétaire. La
  signature, et non l'origine ni TLS, est ce qui autorise une installation sans
  témoin. Avec une clé, ArduinoOTA reste coupée : elle ne vérifie rien.
- **Anti-retour** (S4) : chaque image porte sa version dans son descripteur
  d'application (`version_image.cpp`, symbole faible du cœur remplacé) ; le
  socle la lit dans les premiers octets et refuse une version plus ancienne
  avant toute écriture, par tous les chemins distants. Une image ancienne,
  même signée, ne se réinstalle pas à distance ; une version cassée se corrige
  par une version plus récente. La page locale l'admet sur une case cochée.
- **Quand** : la nuit, dans une plage réglable (03:00-05:00 par défaut) ;
  jamais pendant un défaut, un autotune, un essai ou une identification, un
  entretien, un accès support, ni dans les 10 minutes après un démarrage ou
  avant la validation de l'image courante ; une tentative par nuit, trois par
  version ; une version revenue en arrière (0007) n'est plus jamais installée
  seule sur ce socle.
- **Déploiement progressif** (V9) sans serveur : le socle tire de son
  identifiant un rang stable 0-99 ; le jour *d*, la version est ouverte aux
  rangs < 100 × (*d* + 1) / (`jours` + 1) — 7 jours par défaut, 2 pour un
  correctif de sécurité. Le mainteneur suspend, reprend, ouvre à tous ou
  ré-étale en remplaçant le manifeste (workflow « Déploiement du firmware »).
- **Annoncée** une fois par version (alerte du socle, notification du serveur
  Terrariums), quand c'est le tour du socle ; **désactivable** (`majAuto`),
  **reportable** (1 à 30 jours), **vérifiable à la demande** ; installation
  réussie annoncée après validation. Toute la décision est une fonction pure
  (`majauto.cpp`), testée condition par condition sur PC.

## Conséquences

- Les correctifs atteignent un parc sans geste de chacun, et une mauvaise
  version s'arrête au premier palier (environ 12 % du parc le premier jour).
- Le socle interroge GitHub une fois par jour : GitHub voit son adresse IP
  (politique de confidentialité). Couper l'installation automatique n'arrête
  pas la lecture, qui sert aussi à prévenir.
- Tant que la paire de clés n'existe pas, rien ne s'installe seul : la créer
  (docs/publication.md) est le prérequis de la fonction. La perdre oblige à
  reflasher chaque socle par câble.
- Le chauffage reste coupé pendant le téléchargement (W2 non traité) : une
  minute environ, la nuit, ce qu'un terrarium tient sans peine.
- `ReglagesGlobaux` passe de 64 à 68 octets (relecture tolérante : une mémoire
  plus ancienne garde les mises à jour automatiques actives, plage par
  défaut) ; l'état (report, tentatives, refus, annonce) vit à part en NVS.
