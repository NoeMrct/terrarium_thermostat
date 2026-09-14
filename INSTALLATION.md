# Installation

Trois niveaux, du plus simple au plus complet. Tu peux t'arrêter à celui qui te
suffit.

| Niveau | Ce qu'il faut | Temps | Ce que tu obtiens |
|---|---|---|---|
| **1. Voir l'interface** | un navigateur | 10 secondes | Le rendu, avec des données simulées |
| **2. Développer** | Node.js | 10 minutes | Application + socles simulés + tests |
| **3. Un vrai socle** | le matériel | 2 heures | Un terrarium régulé pour de bon |

---

# Niveau 1 — Voir l'interface tout de suite

Ouvre **`app/demo.html`** d'un double-clic. C'est tout : pas de serveur, pas de
réseau, pas de matériel.

Le fichier contient l'application réelle et un socle simulé qui tourne dans la
page. Les températures évoluent, les boutons fonctionnent, les réglages
aberrants sont refusés avec le message que renverrait un vrai socle.

Ce que tu peux essayer :

- **La liste** montre deux terrariums, dont un avec une sonde en défaut.
- **Ouvre un terrarium** : consignes modifiables, entretien, autotune.
- **Saisis 99 °C** comme consigne de jour : le refus vient du socle lui-même,
  pas d'une vérification recopiée dans l'application.
- **Ajoute-le à ton écran d'accueil** depuis le menu du navigateur, sur mobile.

Ce fichier est **généré** depuis `index.html`, `style.css` et `app.js` : il ne
peut pas diverger de l'application réelle. Pour le régénérer après une
modification :

```
cd outils && node construire-demo.js
```

---

# Niveau 2 — Développer sans matériel

## Ce qu'il faut

- **Node.js 18 ou plus** — [nodejs.org](https://nodejs.org)
- **Mosquitto**, un broker MQTT :
  - macOS : `brew install mosquitto`
  - Debian/Ubuntu : `sudo apt install mosquitto mosquitto-clients`
  - Windows : [mosquitto.org/download](https://mosquitto.org/download/)

> **Sur Debian et Ubuntu, l'installation démarre un service** qui occupe déjà le
> port 1883, avec une configuration sans WebSocket. Tu croirais parler à ton
> broker alors que tu parles à l'autre, et le port WebSocket resterait
> introuvable. Arrête-le d'abord :
> ```
> sudo systemctl stop mosquitto
> ```

## Les dépendances

```
cd outils
npm install mqtt qrcode jsdom
```

## Démarrer le broker

Crée `mosquitto.conf` :

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

## Démarrer un socle simulé

Dans un autre terminal :

```
cd outils
node socle-simule.js --broker mqtt://localhost:1883 --id terraSIM001
```

Il affiche son code d'appairage. Pour en lancer plusieurs, **change
l'identifiant à chaque fois** : deux clients MQTT partageant le même identifiant
se déconnectent mutuellement en boucle.

## Servir l'application

```
cd app
python3 -m http.server 8080
```

Puis ouvre `http://localhost:8080` et saisis :

- **Broker** : `ws://localhost:9001/mqtt`
- **Utilisateur / mot de passe** : laisse vide
- **Préfixe** : `terrarium`

Ajoute ensuite le socle `terraSIM001` avec le code affiché par le simulateur.

> `ws://` non chiffré n'est accepté que depuis `localhost`. Publiée ailleurs,
> l'application exige `wss://` : sans chiffrement, les codes d'appairage
> circuleraient en clair.

## Lancer les tests

```
cd outils
node test-protocole.js   --broker mqtt://localhost:1883 --id terraSIM001 --jeton <code>
node test-application.js --broker ws://localhost:9001/mqtt --id terraSIM001 --jeton <code>
node construire-demo.js && node test-demo.js
```

Et le banc d'essai du régulateur, qui compile le vrai code embarqué :

```
cd sim && make test
```

---

# Niveau 3 — Un socle réel

## Le matériel

| Élément | Nombre |
|---|---|
| ESP32 DevKitC (WROOM-32, 30 broches) | 1 |
| Sonde DS18B20 étanche | 2 |
| Tapis chauffant silicone 12 V 20 W | 2 |
| MOSFET IRLZ44N | 2 |
| Écran OLED SSD1306 0,96" I²C | 1 (facultatif) |
| Résistance 4,7 kΩ | 1 |
| Résistance 10 kΩ | 2 |
| Résistance 100 Ω | 2 |
| Thermostat bilame KSD9700 70 °C NC | 2 |
| Convertisseur LM2596 | 1 |
| Embase jack DC 5,5 × 2,1 mm à bornier | 1 |
| Alimentation 12 V, 3 A | 1 |

Le câblage détaillé est dans le `README.md`, section 1. Trois points à ne pas
rater :

1. **La résistance de 10 kΩ sur chaque grille n'est pas optionnelle.** Sans
   elle, le tapis peut chauffer tout seul pendant le démarrage de l'ESP32.
2. **Le courant des tapis ne passe pas par la masse de l'ESP32.** Carte
   alimentée par le LM2596 (12 V → 5,00 V sur VIN), tapis sur le 12 V, toutes
   les masses réunies en un seul point côté alimentation. USB uniquement pour
   téléverser, 12 V débranché.
3. **La sonde va au point chaud, sous le substrat, contre le tapis.** Jamais
   dans l'air.

## L'environnement de développement

1. Installer l'**IDE Arduino** — [arduino.cc/en/software](https://www.arduino.cc/en/software)
2. **Fichier → Préférences → URL de gestionnaire de cartes**, ajouter :
   ```
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```
3. **Outils → Gestionnaire de cartes** : installer « esp32 » d'Espressif
   (3.3.11 ou plus récent).
4. **Croquis → Gérer les bibliothèques**, installer :
   `OneWire`, `DallasTemperature`, `Adafruit GFX Library`,
   `Adafruit SSD1306`, `PubSubClient`, `ArduinoJson`.
   (Ces six-là et pas une de moins : `ArduinoJson` sert au canal de commande
   MQTT, son absence casse la compilation de `reseau.cpp`.)

## Les réglages de la carte

Ouvrir `terrarium_thermostat.ino` — les autres fichiers apparaissent en onglets.

| Réglage | Valeur |
|---|---|
| Type de carte | ESP32 Dev Module |
| Partition Scheme | **Custom** |
| Flash Size | 4MB |

Le choix « Custom » utilise le `partitions.csv` fourni. Il n'est pas
facultatif : le firmware occupe 1,41 Mo, et le découpage par défaut n'offre que
1,28 Mo — il ne tiendrait pas, et les mises à jour sans fil seraient
impossibles.

## Téléverser et configurer

1. Brancher en USB (12 V débranché), choisir le port, téléverser.
2. Ouvrir le **moniteur série à 115200 bauds**.
3. Au tout premier démarrage, le socle affiche son **code d'appairage** à
   l'écran pendant vingt secondes et sur le port série. **Note-le** — il est
   retrouvable ensuite par la commande `jeton`.
4. Aucun réseau n'est configuré : l'ESP32 ouvre un point d'accès
   `terrarium-config`, mot de passe `terrarium1234`. S'y connecter et ouvrir
   `http://192.168.4.1`, ou passer par le série :
   ```
   wifi MonReseau MonMotDePasse
   redemarrer
   ```
5. L'interface locale est alors sur `http://terrarium.local`.

## Sécuriser

À faire tout de suite, l'accès est ouvert par défaut :

```
motdepasse web MonMotDePasse
motdepasse ota UnAutreMotDePasse
motdepasse ap EncoreUnAutre
```

Tant qu'aucun mot de passe OTA n'est défini, **la mise à jour sans fil par le
réseau n'est pas démarrée du tout** : c'est délibéré, sans mot de passe
n'importe quel appareil du réseau local pourrait réécrire le firmware. Le
journal le dit au démarrage et l'interface web l'affiche en haut de page. La
commande ci-dessus l'active au redémarrage suivant. Entre-temps, l'onglet
Réseau de l'interface web permet quand même de téléverser un firmware, protégé
par le mot de passe de l'interface.

Vérifie avec `reseau` : la ligne « OTA reseau » doit dire « active et
protegee ».

## Lier les sondes aux zones

```
scan
lier 0 1
lier 1 2
```

Sans cette association figée, l'ordre de découverte des sondes peut s'inverser
après une coupure de courant, et les deux zones chaufferaient chacune à la
consigne de l'autre.

## Régler et calibrer

```
jour 1 32
nuit 1 26
heures 1 08:00 20:00
alim 3
chute 1 2 300
```

Tout cela se règle aussi depuis l'interface web (onglet Réglages, y compris la
carte « Réglages généraux » pour l'alimentation et le cyclage saisonnier) et
depuis l'application, à distance.

Puis laisser tourner **une nuit à vide**, comparer à un thermomètre de
référence, et corriger :

```
offset 1 -0.4
```

Une fois le terrarium en place et stabilisé, lancer la calibration
automatique :

```
autotune 1
```

## Vérifier avant d'installer un animal

Terrarium vide, dans cet ordre :

1. `scan` renvoie deux sondes avec des températures plausibles.
2. Au multimètre, vérifier qu'un seul MOSFET conduit à la fois.
3. Une nuit de relevés comparés à un thermomètre indépendant, puis `offset`.
4. Débrancher volontairement une sonde : défaut en moins de 10 secondes,
   chauffage coupé.
5. Couper l'alimentation quelques minutes : au redémarrage, le défaut est
   toujours là et l'heure est signalée comme approximative.
6. **Vérifier les sécurités physiques** : le bilame KSD9700 de chaque plaque
   est en série avec son tapis et bien plaqué sur l'aluminium. Aucun firmware
   ne survit à un MOSFET qui claque en court-circuit ; c'est lui qui coupe dans
   ce cas. Thermofusible et fusible 12 V restent à ajouter.

---

# Connecter le socle à l'application

Une fois le socle en service, pour le piloter de l'extérieur de chez toi.

## 1. Un broker accessible

**HiveMQ Cloud** ou **EMQX Serverless** offrent une centaine d'appareils sans
frais. Créer un cluster en région européenne, puis **un compte par socle**, avec
des droits limités à `terrarium/<son-id>/#`. Sans ce cloisonnement, un socle
compromis pourrait écouter et commander tous les autres.

## 2. Configurer le socle

```
mqtt abcdef.s1.eu.hivemq.cloud 8883 socle-salon MOT_DE_PASSE
mqtt tls on
redemarrer
```

Vérifier avec `reseau`.

## 3. Publier l'application

```
npx wrangler pages deploy app --project-name terrariums
```

ou glisser le dossier `app/` sur [Netlify Drop](https://app.netlify.com/drop).
**HTTPS est obligatoire** : sans lui, ni l'installation sur l'écran d'accueil ni
l'accès à la caméra ne fonctionnent.

## 4. Appairer

Ouvrir l'application, saisir l'adresse du broker, puis ajouter le socle avec son
identifiant et son code d'appairage. Pour éviter de recopier 24 caractères,
imprimer une étiquette :

```
cd outils
node qr-appairage.js --id terraA1B2C3 --jeton <code> > etiquette.svg
```

---

# Si ça ne marche pas

| Symptôme | Cause probable |
|---|---|
| `scan` ne trouve aucune sonde | Résistance de 4,7 kΩ absente, ou mauvaise broche |
| Les zones semblent inversées | Association non figée : `scan` puis `lier` |
| Un tapis chauffe au démarrage | Résistance de 10 kΩ manquante sur la grille |
| « Chauffe sans effet » et plaque brûlante | Le bilame a ouvert : la sonde n'est plus sur la plaque |
| L'ESP32 redémarre quand un tapis s'allume | Retour des tapis par la masse de la carte : refaire le point d'étoile |
| `terrarium.local` inaccessible | Le réseau bloque le mDNS : utiliser l'adresse IP affichée à l'écran |
| La compilation manque de place | Partition Scheme mal réglé : choisir **Custom** |
| L'application ne voit rien | Port WebSocket du broker, ou le service mosquitto du système qui occupe le port |
| Deux socles se déconnectent en boucle | Ils partagent le même identifiant MQTT |
| La température n'atteint jamais la consigne | Charge à 100 % : alimentation ou tapis sous-dimensionné, relever `alim` |
| L'appareil redémarre seul | La cause du redémarrage est écrite dans le journal |

---

# Où aller ensuite

- **`README.md`** — fonctionnement détaillé, algorithmes expliqués, toutes les
  commandes, mise à jour sans fil.
- **`PROTOCOLE.md`** — pilotage à distance : sujets MQTT, actions, sécurité.
- **`app/README.md`** — l'application : déploiement, choix de conception,
  limites.
- **`outils/README.md`** — socle simulé, tests, étiquettes d'appairage.
