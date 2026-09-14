# Outils de développement

Des utilitaires Node pour travailler sur l'application et l'interface web sans
matériel, vérifier le protocole, et préparer les étiquettes des socles.

```
npm install
```

Les versions sont figées dans `package.json` — notamment celle de MQTT.js, qui
doit correspondre à la copie embarquée dans `app/vendor/` (la CI le vérifie).

| Raccourci | Effet |
|---|---|
| `npm test` | Démonstration + interface web embarquée, sans broker |
| `npm run socle` | Lance un socle simulé |
| `npm run test:protocole` | Toutes les actions de `PROTOCOLE.md` |
| `npm run test:application` | L'application réelle, de bout en bout |
| `npm run qr -- --id … --jeton …` | Étiquette d'appairage |

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
peut pas diverger de l'application réelle. Seule la bibliothèque MQTT est
remplacée par une imitation qui répond dans la page.

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
