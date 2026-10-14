# Outils de développement

Des utilitaires Node pour travailler sur l'application et l'interface web sans
matériel, vérifier le protocole et le serveur, préparer les étiquettes des
socles, provisionner un socle en fin de ligne et tester une vraie carte.

```
npm install
```

Les versions sont figées dans `package.json`. MQTT.js n'y sert qu'au socle
simulé et aux tests : l'application, elle, a son propre client (`app/mqtt.js`).

| Raccourci | Effet |
|---|---|
| `npm test` | Démonstration, interface web embarquée, page compressée et aide à jour, budget de poids, intégrité de l'installateur, lint (ESLint), types (`tsc --checkJs`) — sans broker |
| `npm run socle` | Lance un socle simulé |
| `npm run test:protocole` | Toutes les actions de `PROTOCOLE.md`, et la conformité de chaque message à `protocole.schema.json` |
| `npm run test:mqtt` | Le client MQTT de l'application, face à un vrai broker (QoS 1 et réémission compris) |
| `npm run test:application` | L'application réelle dans jsdom, de bout en bout |
| `npm run test:navigateur` | L'application réelle dans un vrai Chromium : CSP, agent de service, dialogues, export, diagnostic (Playwright) |
| `npm run test:accessibilite` | axe-core sur chaque écran, clair et sombre (Playwright) |
| `npm run test:visuel` | Régression visuelle : chaque écran de la démonstration comparé pixel à pixel aux références de `references-visuelles/` ; `--mettre-a-jour` les refait (Playwright, pngjs) |
| `npm run test:charge` | 100 socles simulés et 10 applications sur le broker local, puis l'interface à 20 socles : latence, mémoire, aucun message perdu |
| `npm run test:navigateur:webkit`, `:firefox` | Le même test de navigateur dans WebKit ou Firefox (`npx playwright install webkit firefox`) |
| `npm run test:serveur` | Le serveur Terrariums de bout en bout : comptes, droits par socle, revendication par le code d'appairage, historique, push, rapports |
| `npm run couverture` | Couverture de `app/app.js` et `app/mqtt.js` par c8 sur les tests jsdom (seuils dans `package.json`) |
| `npm run test:qr` | L'encodeur QR du firmware relu par jsQR |
| `npm run lighthouse` | Lighthouse CI : performance, accessibilité, bonnes pratiques, SEO ≥ seuils de `.lighthouserc.json` |
| `npm run page:gz` | Régénère `page_web_gz.h` après une modification de `page_web.h` |
| `npm run aide` | Régénère `app/aide.html` et `app/aide.en.html` depuis `docs/manuel.md` et `docs/manuel.en.md` |
| `npm run pdf` | Imprime en PDF la fiche de démarrage rapide et les deux manuels (`pdf/`, joints à chaque release) (Playwright) |
| `npm run hooks` | Active le hook de pré-commit du dépôt (`.githooks/pre-commit` : lint, types, générateurs à jour) |
| `npm run icones` | Régénère les PNG de `app/icones/` depuis `app/icone.svg` (Playwright) |
| `npm run captures` | Photographie la démonstration en clair/sombre, téléphone/ordinateur (Playwright) ; `captures:manifest` écrit aussi les captures du manifeste |
| `npm run qr -- --id … --jeton …` | Étiquette d'appairage |
| `npm run publication` | Ce que Netlify exécute au déploiement : `version.json` (commit et dernière version du firmware), nom de cache de l'agent de service, minification par terser avec cartes de sources (`--sans-minifier` pour l'éviter), firmware de la dernière release |
| `node signer-firmware.js` | Clés et signature des images de mise à jour (voir `docs/publication.md`) |
| `node verifier-taille-firmware.js <bin>` | Échoue au-delà de 95 % de l'emplacement d'application — courant (1,69 Mo) et ancien (1,5 Mo, socles flashés avant 3.4) |
| `node provisionner.js --port … [--serveur … --admin …]` | Fin de ligne : lit l'identifiant et le code sur la console, lance `test usine`, crée le compte sur le serveur et configure le socle, écrit l'étiquette QR et une fiche (dans `provisionnement/`, ignoré par git) |
| `node test-materiel.js --port … [--flasher dossier] [--ota http://socle]` | Test de fumée sur une vraie carte par le port série, sans dépendance native : flashage par esptool, démarrage, console, santé, auto-test usine, 30 s sans redémarrage, mise à jour par `/api/maj` et validation (`.github/workflows/materiel.yml`) |
| `sh installer-bibliotheques.sh` | Installe les bibliothèques Arduino aux versions de `bibliotheques.txt` (celles de la CI et de `NOTICE.md`) |

`navigateur`, `accessibilite`, `visuel`, `charge` (pour l'interface),
`lighthouse`, `icones`, `captures` et `pdf` ont besoin de Playwright (et
d'axe-core, de Lighthouse CI), volontairement absents de `package.json` pour
garder `npm install` léger :
`npm install --no-save playwright@1.56.0 axe-core @lhci/cli && npx playwright install chromium`.
La CI les installe ainsi ; la version de Playwright est épinglée parce que les
références visuelles dépendent du rendu de son Chromium.

---

## 1. Un socle simulé

`socle-simule.js` se connecte à un broker et se comporte comme un vrai socle :
mêmes sujets, mêmes messages, mêmes règles de validation, même testament. Il
permet de développer et de démontrer l'application avant d'avoir soudé quoi que
ce soit.

```
node socle-simule.js --broker mqtt://localhost:1883 --id terraSIM001
```

Options : `--jeton`, `--prefixe`, `--user`, `--pass`.

Lancer plusieurs socles pour tester la liste :

```
node socle-simule.js --id terraSALON  --jeton SALON000000000000000001 &
node socle-simule.js --id terraBUREAU --jeton BUREAU00000000000000001 &
```

**Chaque instance doit avoir un identifiant différent.** Deux clients partageant
le même identifiant se déconnectent mutuellement en boucle — c'est le
comportement normal d'un broker MQTT, et c'est aussi ce qui arriverait avec deux
socles mal configurés.

Ce simulateur **n'est pas le firmware** : c'est une imitation de son interface
réseau. Son comportement thermique est grossier, volontairement. Le vrai banc
d'essai du régulateur est dans `sim/`, et lui compile le code embarqué.

---

## 2. Le test du protocole

`test-protocole.js` exerce toutes les actions documentées dans `PROTOCOLE.md` et
vérifie la forme des réponses. Il fonctionne aussi bien contre un socle simulé
que contre un vrai.

```
node test-protocole.js --broker mqtt://localhost:1883 \
                       --id terraSIM001 --jeton SIMULATIONTESTJETON00001
```

51 vérifications réparties en quatorze sections : présence, publication
spontanée, lecture sans jeton, refus des commandes non authentifiées, réglage
d'une zone, rejet des réglages dangereux, entretien, puissance disponible,
statistiques, historique, réglages généraux, réglages fins des diagnostics,
actions diverses, et robustesse face à un message malformé.

Il sert de garde-fou : si le firmware, le simulateur et la documentation
divergent, ce test le dit. C'est lui qui a révélé que le filtre d'abonnement
`zone+/etat` était invalide — le joker MQTT doit occuper un niveau entier, et le
rejet emportait silencieusement tout l'abonnement. C'est lui aussi qui a mis en
évidence que `stats` et `historique`, annoncées comme lectures autorisées sans
jeton, n'étaient implémentées nulle part et répondaient « action inconnue ».

---

## 3. Le test de l'application

`test-application.js` charge la **vraie** application — `index.html` et
`app.js` — dans un DOM headless, la connecte au broker et la fait dialoguer
avec un socle simulé. Il vérifie ce qu'aucun contrôle de syntaxe ne peut voir :
le modèle d'état, l'analyse des sujets, le rendu, et le comportement quand le
socle ne répond pas.

```
node test-application.js --broker ws://localhost:9001/mqtt \
                         --id terraSIM001 --jeton SIMULATIONTESTJETON00001
```

40 vérifications : premier lancement, refus d'une liaison non chiffrée hors
développement, connexion, ajout d'un socle, rejet des saisies incorrectes, vue
détaillée, commande acceptée, refus venu du socle, entretien, socle injoignable,
réglages complets d'une zone (avec aller-retour des horaires), courbes,
réglages de l'appareil, persistance et retrait d'un socle.

Le test du socle injoignable est le plus utile : il mesure que l'échec est
signalé en huit secondes au lieu de laisser l'interface figée, et que
l'application rappelle bien que le socle continue de réguler tout seul.

## 4. La démonstration autonome

`construire-demo.js` assemble `app/demo.html` : un fichier unique, ouvrable d'un
double-clic, qui fait tourner la vraie application avec un socle simulé dans la
page. Aucun serveur, aucun broker, aucun réseau.

```
node construire-demo.js
node test-demo.js
```

Le fichier est **généré** depuis `index.html`, `style.css` et `app.js` : il ne
peut pas diverger de l'application réelle. Seul le client MQTT est remplacé par
une imitation qui répond dans la page, et la politique de sécurité (CSP) de la
vraie page en est retirée, puisque tout y est en ligne.

C'est ce fichier qui a révélé que l'application affichait toutes les zones en
panne : le socle publie `defaut: "0"` pour Home Assistant, et la chaîne `"0"`
est vraie en JavaScript.

## 5. Le test de l'interface web embarquée

`test-page-web.js` extrait la page servie par l'ESP32 de `page_web.h`, la charge
dans un DOM sans navigateur et lui répond à la place du socle.

```
node test-page-web.js
```

35 vérifications : rendu des zones, échappement d'un nom piégeux, graphique et
survol, formulaires de zone (les requêtes réellement émises sont inspectées),
réglages généraux, arrêt d'autotune, avertissement quand l'OTA n'est pas
protégée, sélecteur de durée sur une petite partition, statistiques, sondes,
journal.

Cette page n'avait aucun test : une faute de frappe n'apparaissait qu'une fois
le firmware flashé, avec pour seul symptôme une page muette. Elle en a révélé
deux — le survol du graphique qui ne recevait jamais ses points, et un sélecteur
de durée qui restait vide sur les petites partitions.

---

## 6. L'étiquette d'appairage

```
node qr-appairage.js --id terraA1B2C3 --jeton K7M2QX4TBW9HRPFZ3NXCVJ8D > etiquette.svg
```

Produit une étiquette SVG de 300 × 400 avec le QR code, l'identifiant et le code
en clair groupé par six. Le QR contient `terrarium:<id>:<jeton>`, format que
l'application sait lire.

Le QR est mis à l'échelle depuis le `viewBox` du SVG produit par la
bibliothèque, qui dessine en **modules** et non en points : le nombre de modules
varie avec la longueur de l'identifiant, une échelle figée donnerait un code
minuscule pour les uns et débordant pour les autres.

Recopier 24 caractères à la main est la principale source d'échec à la mise en
service : pour un produit, cette étiquette n'est pas un luxe.

---

## 7. Broker local pour développer

```
sudo apt install mosquitto mosquitto-clients
```

**Attention** : l'installation démarre un service qui occupe déjà le port 1883,
avec une configuration par défaut sans WebSocket. Il faut l'arrêter avant de
lancer le sien, sinon on croit parler à son broker alors qu'on parle à l'autre —
et le port WebSocket reste introuvable.

```
sudo systemctl stop mosquitto
```

Fichier `mosquitto.conf` :

```
listener 1883 127.0.0.1
protocol mqtt

listener 9001 127.0.0.1
protocol websockets

allow_anonymous true
```

```
mosquitto -c mosquitto.conf
```

L'application se connecte alors sur `ws://localhost:9001/mqtt`. En local, le
navigateur accepte `ws://` non chiffré ; **l'application refuse une adresse non
`wss://`** dès qu'elle n'est plus servie depuis `localhost`, pour ne pas
laisser passer les codes d'appairage en clair sur un vrai réseau.

Observer tout ce qui circule :

```
mosquitto_sub -h localhost -t 'terrarium/#' -v
```

---

## 8. Un cycle de travail complet

```
mosquitto -c mosquitto.conf &
node socle-simule.js --id terraSIM001 &
node test-page-web.js
node test-protocole.js   --id terraSIM001 --jeton SIMULATIONTESTJETON00001
node test-application.js --id terraSIM001 --jeton SIMULATIONTESTJETON00001
cd ../app && python3 -m http.server 8080
```

Puis ouvrir `http://localhost:8080`, saisir `ws://localhost:9001/mqtt` comme
broker, et ajouter le socle `terraSIM001` avec son code. L'application affiche
alors des températures qui évoluent, et toutes les commandes fonctionnent.

## 6. Le client MQTT de l'application

`test-mqtt.js` charge `app/mqtt.js` dans un DOM sans navigateur, sur le
WebSocket de jsdom, face à un vrai broker ; MQTT.js, en TCP, lui sert de
correspondant.

```
node test-mqtt.js --broker ws://localhost:9001/mqtt --tcp mqtt://localhost:1883
```

16 vérifications : CONNACK, SUBACK, réception UTF-8 par joker, message
persistant, charge de 20 Ko (longueur sur trois octets), QoS 1 acquitté,
publication texte et binaire, désabonnement, keepalive, reconnexion après une
coupure par le broker, refus d'identifiants, fin propre sans reconnexion. Le
refus n'est vérifié que si le broker refuse quelqu'un : la CI configure
Mosquitto avec un fichier de comptes pour cela.

## 7. La page embarquée compressée

`compresser-page.js` extrait le HTML de `page_web.h`, le compresse en gzip et
écrit `page_web_gz.h`, que le firmware sert tel quel avec
`Content-Encoding: gzip` : 24 Ko en clair deviennent 8,5 Ko en flash.

```
node compresser-page.js             # après toute modification de page_web.h
node compresser-page.js --verifier  # ce que fait la CI
```

Le conteneur gzip est écrit à la main, sans date ni système, pour que le
fichier généré ne dépende pas de la machine. La vérification décompresse le
fichier et compare au HTML courant plutôt que de comparer des octets, parce que
deux versions de zlib peuvent compresser différemment.

## 8. Budget de poids

`budget.js` échoue si un fichier de `app/` dépasse sa taille gzip autorisée.
L'application entière — HTML, CSS, scripts, client MQTT — tient sous 40 Ko
compressés ; c'est le garde-fou contre une bibliothèque ajoutée sans y penser.
