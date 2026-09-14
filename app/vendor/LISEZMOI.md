# Bibliothèques embarquées

## mqtt.min.js — MQTT.js v5.15.2 (MIT)

Copie figée de `node_modules/mqtt/dist/mqtt.min.js`.

Elle est embarquée, et non chargée depuis un CDN, pour deux raisons :

- **L'application doit s'ouvrir hors ligne.** L'agent de service ne met en
  cache que les fichiers de la même origine : un script tiers ne l'est pas,
  donc l'application se chargeait mais restait inerte sans réseau — la coque
  s'affichait, la connexion au broker était impossible.
- **La version doit être figée.** L'ancienne adresse `unpkg.com/mqtt/dist/…`
  ne mentionnait aucune version : une publication majeure en amont aurait pu
  casser l'application du jour au lendemain, sans qu'une seule ligne du dépôt
  ne change.

Pour mettre à jour :

```
npm install mqtt@<version>
cp node_modules/mqtt/dist/mqtt.min.js app/vendor/mqtt.min.js
```

puis relancer `node outils/test-application.js` et `node outils/construire-demo.js`.
