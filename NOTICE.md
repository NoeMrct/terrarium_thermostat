# Logiciels tiers embarqués ou distribués

Le projet lui-même est sous licence MIT (voir `LICENSE`). Les composants
suivants sont compilés dans le firmware, copiés dans l'application ou
installés par le serveur ; leurs licences s'appliquent à leur partie et
doivent accompagner toute distribution (binaire du firmware, site publié,
image Docker). Les versions sont celles d'`outils/bibliotheques.txt`,
`outils/package.json` et `serveur/package.json`.

## Firmware (compilé dans le binaire ESP32)

| Composant | Version | Licence | Auteur / origine |
|---|---|---|---|
| Arduino core for the ESP32 (`esp32:esp32`) | 3.3.11 | LGPL-2.1 (cœur) ; ESP-IDF et ses composants : Apache-2.0 | Espressif Systems |
| Magasin de certificats racine (`x509_crt_bundle`) | fourni avec le cœur | Mozilla Public License 2.0 (données CA de Mozilla) | Mozilla, via Espressif |
| mbedTLS | fourni avec ESP-IDF | Apache-2.0 | Arm Limited |
| OneWire | 2.3.8 | Licence MIT (Jim Studt, Paul Stoffregen et contributeurs) ; portions Copyright 2000 Dallas Semiconductor (MIT-like) | github.com/PaulStoffregen/OneWire |
| DallasTemperature | 4.0.6 | MIT | Miles Burton et contributeurs |
| Adafruit GFX Library | 1.12.6 | BSD (Software License Agreement) | Adafruit Industries |
| Adafruit BusIO | 1.17.4 | MIT | Adafruit Industries |
| Adafruit SSD1306 | 2.5.17 | BSD (Software License Agreement) | Adafruit Industries |
| PubSubClient | 2.8 | MIT | Nicholas O'Leary |
| ArduinoJson | 7.4.2 | MIT | Benoît Blanchon |

Le cœur ESP32 étant sous LGPL-2.1, le firmware est distribué avec ses sources
(ce dépôt), ce qui satisfait l'obligation de permettre la reconstruction. Les
avis de licence BSD d'Adafruit exigent la reproduction du texte de licence dans
la documentation accompagnant une distribution binaire : c'est ce fichier.

## Application web (fichiers publiés sur le site)

| Composant | Version | Licence | Où |
|---|---|---|---|
| ESP Web Tools | 10.4.0 | Apache-2.0 | `app/installateur/` (copie telle quelle, licence jointe dans `app/installateur/LICENSE`, sommes dans `LISEZMOI.md`) |
| esptool-js, Improv Wi-Fi (dépendances d'ESP Web Tools) | incluses dans le paquet | Apache-2.0 | idem |

L'application elle-même (`app/app.js`, `app/mqtt.js`, `app/sw.js`, styles,
icônes) est originale et sous MIT. Aucune police, bibliothèque ou image tierce
n'est chargée à l'exécution.

## Serveur (installé par `npm ci` dans `serveur/`)

| Composant | Licence |
|---|---|
| aedes (broker MQTT) | MIT |
| mqtt.js | MIT |
| ws | MIT |
| web-push | MPL-2.0 |

Leurs dépendances transitives sont sous licences MIT, ISC ou BSD ; la liste
exacte s'obtient avec `npx license-checker --summary` dans `serveur/`. web-push
étant sous MPL-2.0, toute modification de ses fichiers doit être publiée sous
la même licence ; le serveur l'utilise sans le modifier.

## Outils de développement (non distribués)

jsdom, ESLint, TypeScript, ajv, terser, c8, pngjs, jsQR, qrcode, Playwright,
axe-core, Lighthouse CI : licences MIT ou MPL-2.0 (axe-core), utilisés pour
tester et préparer la publication, jamais livrés à l'utilisateur.

## Matériel de référence

Les schémas et la nomenclature (`docs/`) décrivent des composants du commerce
(ESP32-DevKitC, SSD1306, DS18B20, IRLZ44N, LM2596, KSD9700) : aucune licence
logicielle ne s'y attache.
