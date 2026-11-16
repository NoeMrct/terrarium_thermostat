# Publier une version

## Ce qui est automatique

| Déclencheur | Ce qui se passe |
|---|---|
| chaque `git push` | CI complète (`verification.yml`) : bancs PC (sanitizers, couverture, clang-tidy, fuzzing), lint, types, protocole, application dans jsdom et Chromium, accessibilité, régression visuelle, charge, serveur, Lighthouse, compilation ESP32 reproductible et taille, matrice WebKit/Firefox |
| chaque `git push`, et le lundi | `codeql.yml` : CodeQL JavaScript et C++ du firmware (compilation arduino-cli observée) ; périmètre dans `.github/codeql/codeql-config.yml` |
| déploiement Netlify (chaque push sur `main`) | `npm ci --prefix outils --omit=dev && node outils/preparer-publication.js` : `version.json` (commit de l'application **et** dernière version du firmware publiée), nom de cache de l'agent de service = commit, minification de `app.js`/`mqtt.js`/`sw.js` par terser avec cartes de sources, binaires de la dernière release copiés pour la page « Flasher un socle » |
| étiquette `vX.Y.Z` | `publication.yml` : clé de signature contrôlée contre `config.h`, compilation reproductible, signature vérifiée si la clé est configurée, manifeste des mises à jour automatiques (`terrarium-version.json`), attestation de provenance, PDF de la documentation, release GitHub avec les binaires, les PDF et les notes du changelog, redéploiement du site si le hook est configuré |
| à la main (onglet Actions) | `deploiement.yml` : déploiement progressif d'une release — `pause`, `reprendre`, `tous`, `etaler` sur N jours (voir « Mises à jour automatiques ») |
| toutes les 30 minutes | `surveillance.yml` : le serveur en ligne répond en HTTPS, le MQTT chiffré des socles (8883) accepte une connexion TLS vérifiée, le certificat vaut encore 10 jours ; un échec prévient par e-mail (voir `serveur/deploiement/machine/LISEZMOI.md`) |
| exécuteur auto-hébergé avec une carte | `materiel.yml` : flashage et test de fumée par port série (`outils/test-materiel.js`) — à la demande ou à chaque étiquette |

L'application n'a pas de numéro à elle : elle est publiée en continu et affiche
le commit dont elle sort (pied de page, diagnostic). Son agent de service se
renouvelle à chaque déploiement sans intervention ; l'utilisateur voit
« Nouvelle version disponible — Recharger ».

## Sortir une version du firmware

1. `config.h` : `FW_VERSION "X.Y.Z"` (et `PROTO_VERSION` si le protocole change ;
   `protocole.schema.json` et `PROTOCOLE.md` suivent).
2. `CHANGELOG.md` : déplacer *Non publié* sous `## [X.Y.Z] — AAAA-MM-JJ`.
3. `node outils/compresser-page.js` si `page_web.h` a changé ;
   `node outils/construire-aide.js` si un manuel a changé ; `npm test` dans
   `outils/` et `make test` dans `sim/`.
4. Commit, puis :
   ```
   git tag vX.Y.Z
   git push && git push --tags
   ```
5. Vérifier la release sur GitHub (cinq binaires + sommes SHA-256 ; six avec la
   signature ; `terrarium-version.json` ; trois PDF), puis la page « Flasher un
   socle » du site, qui doit annoncer X.Y.Z, et la carte « Mise à jour du
   firmware » de l'application, qui doit la proposer aux socles en retard.
   Les socles qui exigent des images signées l'installeront seuls, la nuit,
   au rythme du déploiement progressif (7 jours par défaut, 2 pour une section
   `### Sécurité`) ; une ligne `Résumé : …` dans la section du CHANGELOG
   devient le texte de leur annonce (sinon, les titres en gras des entrées).

## Compilation reproductible et provenance

Le workflow compile avec `SOURCE_DATE_EPOCH` = date du commit et
`-DFW_COMMIT="<sha court>"` : la date de compilation affichée (`FW_BUILD`) est
celle du commit, pas celle de la machine, et deux compilations du même commit
**au même chemin, avec le même cœur ESP32 déjà compilé** donnent le même
binaire (le chemin des sources entre dans le descripteur d'application ; la CI
recompile le sketch et compare — recompiler le cœur lui-même n'est pas
déterministe, ce qui vient d'en amont). La provenance est
attestée par `actions/attest-build-provenance` : quiconque peut vérifier
qu'un binaire sort bien de ce dépôt et de ce commit :

```
gh attestation verify terrarium-X.Y.Z-firmware.bin --repo NoeMrct/terrarium_thermostat
```

Les bibliothèques sont épinglées (`outils/bibliotheques.txt`,
`outils/installer-bibliotheques.sh`) et le cœur ESP32 à sa version exacte :
une mise à jour de dépendance est un commit, jamais un hasard de la CI.

## La mise à jour tirée par les socles

Un socle en service se met à jour depuis l'application : il télécharge
`terrarium-X.Y.Z-firmware.bin` (ou `.signe.bin` s'il exige des images signées)
sur la release, en HTTPS. Il n'accepte comme origine que
`MAJ_ORIGINES_AUTORISEES` de `config.h` (les releases de ce dépôt) : un fork
doit y mettre son propre dépôt, ainsi que dans `MAJ_URL_MODELE` et
`MAJ_URL_MODELE_SIGNE`. `outils/verifier-taille-firmware.js` fait échouer la
publication si le binaire dépasse 95 % de l'emplacement de `partitions.csv`.
Depuis la 3.5.0, le firmware ne tient plus dans les emplacements de 1,5 Mo des
socles flashés avant la 3.4.0 : ceux-là se reflashent une fois par câble (la
mise à jour à distance refuse le binaire sans rien casser).

## Mises à jour automatiques et déploiement progressif

Chaque jour, un socle lit `terrarium-version.json` à l'adresse stable de la
dernière release (`…/releases/latest/download/terrarium-version.json` :
GitHub ne la fait jamais pointer vers une pré-version). Il installe seul la
nouvelle version la nuit (03:00-05:00 par défaut, réglable), si son tour est
venu, s'il exige des images signées et si rien ne s'y oppose (défaut,
autotune, essai, entretien, accès support) — détail dans `PROTOCOLE.md`,
« Mises à jour automatiques ». Le propriétaire peut les couper ou les reporter
(application, page locale, console `maj auto|plage|reporter`).

Le manifeste porte la montée en charge : le jour *d*, la version est ouverte à
(*d* + 1) / (`jours` + 1) des socles, chacun tirant un rang stable de son
identifiant. Pour une version qui pose problème : Actions → « Déploiement du
firmware » → `pause` (plus aucune installation automatique ; les socles déjà
passés gardent le retour arrière automatique, et une version corrigée se
publie avec un numéro plus grand — l'anti-retour refuse de redescendre).
`reprendre` relance la montée là où elle en était, `tous` l'ouvre à tous,
`etaler` la recommence sur N jours. Le manifeste est remplacé dans la release
(il n'est pas dans les sommes SHA-256 : il change) ; les images ne changent
jamais et restent signées.

## Signature des images (S5) — à faire une fois, avant toute vente

Sans clé compilée, un socle accepte n'importe quelle image envoyée par sa page
locale (mot de passe exigé) et ne s'installe **rien** seul. Avec elle, il
n'accepte plus que des images signées, coupe ArduinoOTA (qui ne vérifie rien)
et s'installe seul les mises à jour. La paire de clés se crée **chez le
mainteneur, jamais dans le dépôt ni dans une conversation** :

1. Sur son ordinateur, hors du dossier du dépôt (l'outil refuse d'écrire la clé
   privée dedans, et n'écrase jamais une clé existante) :
   ```
   node outils/signer-firmware.js --generer-cles <dossier sûr>/terrarium-privee.pem --config config.h
   ```
   La clé publique s'écrit dans `config.h` (`OTA_CLE_PUBLIQUE`, au format que
   vérifie clang-format) ; `node outils/signer-firmware.js --etat` le confirme.
2. GitHub → Settings → Secrets and variables → Actions → New repository
   secret : `CLE_SIGNATURE_FIRMWARE`, valeur = tout le fichier PEM.
3. Deux copies hors ligne de la clé privée (gestionnaire de mots de passe, clé
   USB chiffrée), puis l'effacer du disque de travail. La perdre oblige à
   reflasher chaque socle par câble pour changer de clé ; la voir volée aussi.
4. Commiter `config.h`, publier une version, et flasher **par câble** les
   socles existants avec elle : ils n'acceptent plus ensuite que des images
   signées par cette clé.

Le workflow de publication s'arrête si `config.h` exige des images signées
sans que le secret existe, et vérifie l'image signée contre la clé compilée :
une clé privée qui ne correspondrait pas donnerait une release que tous les
socles refusent. Sans clé compilée, il publie avec un avertissement.

## Secrets du dépôt (Settings → Secrets and variables → Actions)

- `CLE_SIGNATURE_FIRMWARE` : clé privée PEM (voir « Signature des images »
  ci-dessus). Dès que la clé publique est dans `config.h`, `/api/maj`, la mise
  à jour tirée et l'installation automatique n'acceptent plus qu'une image
  signée (`.signe.bin`).
- `NETLIFY_BUILD_HOOK` : Netlify → Site configuration → Build hooks → nouvelle
  URL. Sans lui, le site ne montre le nouveau firmware qu'au prochain push.

## Références visuelles

La régression visuelle compare chaque écran à des captures de référence
(`outils/references-visuelles/`) qui doivent venir de la machine qui compare :
le rendu des polices diffère d'un poste à l'autre. Après un changement
d'apparence voulu, lancer le workflow **Références visuelles** (Actions → Run
workflow) : il régénère les images sur l'exécuteur GitHub et les commite ; le
commit est la revue. En local, `node outils/test-visuel.js --mettre-a-jour`
sert à inspecter, pas à produire les références du dépôt.

## Protection de la branche main (Settings → Branches)

Exiger les vérifications `Bancs d'essai (PC)`, `Protocole, application et
interface web`, `Compilation ESP32`, `Intégrité de l'installateur web`,
`Serveur auto-hébergeable` et `CodeQL / JavaScript` avant fusion, et une revue (CODEOWNERS). Les
fichiers sous `.github/` ne peuvent être modifiés que par un humain du dépôt.
En local, `npm run hooks` (dans `outils/`) active le hook de pré-commit qui
rejoue lint, types et les générateurs (`--verifier`) avant chaque commit.
