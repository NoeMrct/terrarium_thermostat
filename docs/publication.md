# Publier une version

## Ce qui est automatique

| Déclencheur | Ce qui se passe |
|---|---|
| chaque `git push` | CI complète (`verification.yml`) : bancs PC (sanitizers, couverture, clang-tidy, fuzzing), lint, types, protocole, application dans jsdom et Chromium, accessibilité, régression visuelle, charge, serveur, Lighthouse, compilation ESP32 reproductible et taille, matrice WebKit/Firefox (non bloquante) |
| chaque `git push`, et le lundi | `codeql.yml` : CodeQL JavaScript (bloquant) et C++ du firmware (non bloquant) |
| déploiement Netlify (chaque push sur `main`) | `npm ci --prefix outils --omit=dev && node outils/preparer-publication.js` : `version.json` (commit de l'application **et** dernière version du firmware publiée), nom de cache de l'agent de service = commit, minification de `app.js`/`mqtt.js`/`sw.js` par terser avec cartes de sources, binaires de la dernière release copiés pour la page « Flasher un socle » |
| étiquette `vX.Y.Z` | `publication.yml` : compilation reproductible, signature si la clé est configurée, attestation de provenance, PDF de la documentation, release GitHub avec les binaires, les PDF et les notes du changelog, redéploiement du site si le hook est configuré |
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
   signature ; trois PDF), puis la page « Flasher un socle » du site, qui doit
   annoncer X.Y.Z, et la carte « Mise à jour du firmware » de l'application,
   qui doit la proposer aux socles en retard.

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
`MAJ_URL_MODELE_SIGNE`. Un socle flashé avant la 3.4.0 garde ses emplacements
de 1,5 Mo : `outils/verifier-taille-firmware.js` fait échouer la publication si
le binaire n'y tient plus (95 %).

## Secrets du dépôt (Settings → Secrets and variables → Actions)

- `CLE_SIGNATURE_FIRMWARE` : clé privée PEM produite par
  `node outils/signer-firmware.js --generer-cles`. La clé publique affichée va
  dans `config.h` (`OTA_CLE_PUBLIQUE`). Dès qu'elle y est, `/api/maj` et la
  mise à jour tirée n'acceptent plus qu'un `.signe.bin`. Garder la clé privée
  aussi dans un gestionnaire de mots de passe : la perdre oblige à reflasher
  par USB pour en changer. Recommandée avant toute vente.
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
