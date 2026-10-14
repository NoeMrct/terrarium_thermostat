# Contribuer

## Prendre le projet en main

```
make -C sim test                 # bancs C++, sans Arduino, en quelques secondes
cd outils && npm ci && npm test  # démonstration, page embarquée, aide, lint, types, budget
npm run hooks                    # hook de pré-commit : rejoue lint, types et générateurs
```

Pour le reste (broker, application dans un navigateur, Lighthouse, fuzzing),
`outils/README.md` décrit chaque script et la CI (`.github/workflows/verification.yml`)
montre l'ordre dans lequel tout s'enchaîne.

## Règles du dépôt

- **Un fichier généré se régénère, il ne se retouche pas** : `app/demo.html`
  (`construire-demo.js`), `app/aide.html` et `app/aide.en.html`
  (`construire-aide.js`, depuis `docs/manuel.md` et `docs/manuel.en.md` — les
  deux manuels gardent la même structure de sections), `page_web_gz.h`
  (`compresser-page.js`), `app/icones/` (`generer-icones.js`). La CI vérifie
  qu'ils sont à jour.
- **Les structures persistées ne grandissent que par la fin** (`reglages.h` :
  `ReglagesReseau`, `ReglagesGlobaux`…) : une mémoire écrite par l'ancienne
  version doit rester lisible. Les décalages sont figés par `static_assert`, et
  `sim/test-migration.cpp` relit une image de chaque version.
- **Le canal de commandes vit dans `protocole.cpp`**, sans Arduino : une action
  nouvelle s'ajoute là, avec son cas dans `sim/test-protocole.cpp` et son entrée
  dans `protocole.schema.json`, puis son implémentation dans `SocleReel`
  (`reseau.cpp`) et dans `outils/socle-simule.js`.
- **Toute écriture de HTML dans l'application passe par `html()`** (Trusted
  Types) ; un `innerHTML` direct est refusé par le navigateur.
- **Une vérification visuelle qui change d'aspect met à jour ses références**
  (`npm run test:visuel -- --mettre-a-jour`), dans le même commit, et le dit.
- **Le protocole est un contrat** : `PROTOCOLE.md` l'explique, `protocole.schema.json`
  le vérifie. Un changement qu'une application plus ancienne ne comprendrait pas
  incrémente `PROTO_VERSION` dans `config.h`.
- **Les textes de l'application passent par `t()`** dans `app/app.js` ; le
  français est la référence, l'anglais vient du même dictionnaire.
- **Pas de dépendance nouvelle dans l'application** : elle doit rester plus
  légère qu'une photo (`outils/budget.js` le garantit). Les outils peuvent en avoir.
- Les fichiers C++ nouveaux suivent `.clang-format` ; les anciens gardent leur mise
  en forme (ils passeront au formateur dans un commit dédié, sans autre changement).
- Chaque changement visible va dans `CHANGELOG.md`, section *Non publié*.

## Publier une version

1. Mettre à jour `FW_VERSION` dans `config.h` et déplacer *Non publié* vers une
   section `## [X.Y.Z] — date` du `CHANGELOG.md`.
2. `git tag vX.Y.Z && git push --tags`. Le workflow *Publication* compile
   (reproductible, attesté), signe si la clé est configurée, imprime la
   documentation en PDF, crée la release avec les binaires et redéploie le site.
3. Vérifier la page « Flasher un socle » du site, qui doit proposer la nouvelle
   version, et la carte « Mise à jour du firmware » de l'application.

Détails : `docs/publication.md`.
