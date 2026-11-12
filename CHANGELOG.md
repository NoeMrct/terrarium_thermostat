# Journal des versions

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le
numéro de version suit [SemVer](https://semver.org/lang/fr/). Le numéro est
celui du firmware (`FW_VERSION`) ; l'application est publiée en continu et
affiche le commit dont elle est issue.

## [Non publié]

Firmware 3.5.0 (`FW_VERSION`). Le binaire ne tient plus dans les emplacements
de 1,5 Mo des socles flashés avant la 3.4.0 : ceux-là se reflashent une fois
par câble (la mise à jour à distance refuse le binaire sans rien casser). Les
réglages persistés s'enrichissent par la fin : rien n'est perdu à la mise à
jour.

### Ajouté
- **Sondes sûres.** Chaque zone suit l'adresse de sa sonde et une sonde n'est
  jamais liée à deux zones. Plus de repli sur « la n-ième sonde du bus » : une
  zone sans sonde liée reste en défaut SONDE, chauffe coupée. La liaison
  automatique n'a lieu que sans ambiguïté (premier démarrage, ou une seule zone
  libre, une seule sonde orpheline et toutes les autres présentes). `scan` et
  « Relire le bus » relisent vraiment le bus, et il est relu de lui-même toutes
  les 5 min tant qu'une zone n'a pas de mesure.
- **Assistant d'identification** (`identifier <z>`, bouton « Identifier ») :
  le chauffage est suspendu, on serre la sonde voulue dans la main et le socle
  la lie à la zone (2 min au plus).
- **Contrôle croisé « sondes inversées »** : après 6 min de chauffe effective,
  si la sonde de la zone ne bouge pas alors que celle d'une autre zone monte,
  les deux zones passent en défaut CHAUFFE SANS EFFET, avec la raison dans le
  journal et l'alerte. Une chauffe qui ne fait rien monter du tout reste une
  simple alerte.
- **Essai de chauffe guidé** (`essai <z>`, page locale) : la zone chauffe seule
  10 min au plus, sécurités actives, avec un verdict (sa sonde a pris 0,5 °C,
  une autre a monté à sa place, ou rien n'a bougé).
- **Calibration côte à côte** (`calibrer`) : sondes posées ensemble, les
  décalages des autres zones sont alignés sur la zone 1.
- **Valeurs aberrantes filtrées** : un saut de plus de 4 °C entre deux lectures
  n'est retenu qu'après trois confirmations.
- **Alerte « trop chaud »** : une zone au-dessus de sa consigne, au-delà du seuil
  de dérive et pendant sa durée, alors qu'elle ne chauffe pas (canicule, lampe)
  est signalée : alerte urgente, marqueur à l'écran, champ `tropChaud` dans
  l'état.
- **Diagnostic sans câble.** Bouton BOOT : appui court, page suivante de
  l'écran (zones, courbes des 6 dernières heures, réseau, sondes, système) ;
  3 s, QR d'appairage ; 10 s, point
  d'accès de configuration. LED bleue, de la plus importante à la plus banale :
  défaut, identification ou essai, point d'accès, Wi-Fi absent, MQTT refusé,
  tout va bien (`led off` l'éteint). Ligne d'état en bas de l'écran.
- **Écran** : flèches de tendance, atténué la nuit (`ecran nuit
  <attenue|normal|eteint>`), messages temporaires.
- **Rapport quotidien** (`rapport <HH:MM>`, page locale) : températures sur
  24 h, heures de chauffe, kWh, coût et défauts, vers l'URL d'alerte (priorité
  basse pour ntfy) et le sujet MQTT `rapport`.
- **Coût en euros** (`prix <€/kWh>`) dans `stats`, la page locale et le rapport.
- **Résumés journaliers sur un an** (`jours [n]`, `/api/jours`, tableau de
  l'onglet Appareil).
- **Jour et nuit calés sur le soleil** (`soleil <lat> <lon> [décalage]`) : lever
  et coucher recalculés chaque jour à la place des horaires fixes.
- **Zone prioritaire** (`priorite <z>`) : quand l'alimentation ne suffit pas aux
  deux tapis, elle reçoit la plus grande part du temps de chauffe.
- **Wi-Fi de secours** (`wifi2 <ssid> [mdp]`, onglet Réseau), essayé en
  alternance quand le premier ne répond pas.
- **Sauvegarde et restauration de la configuration** (`/api/sauvegarde`,
  onglet Appareil) : zones, réglages, sondes liées, alertes ; tout ou rien ;
  jamais de mot de passe dans le fichier.
- **Alertes de démarrage** : durée d'une coupure de courant (en fourchette) au
  retour de l'heure, trois redémarrages anormaux de suite, mémoire fragmentée.
- Santé : `mqtt` (état de la connexion au broker) et `webProtege` ; la page
  locale avertit quand elle n'a pas de mot de passe.
- Application : un conseil sous chaque défaut, marqueur « trop chaud ».
- Tests : bancs `test-liaisons` et `test-soleil`, scénarios 21 à 28 du
  simulateur (sondes inversées, couplage légitime, pic isolé, canicule,
  priorité, essai de chauffe, soleil), fuzzing des liaisons et du soleil, tests
  de la page locale pour chaque nouveauté.

### Modifié
- Réessais MQTT espacés : 15 s, puis doublés jusqu'à 5 min, au lieu d'un essai
  toutes les 5 s contre un broker qui refuse.
- Négociation TLS des alertes et de la mise à jour tirée bornée à 5-6 s.
- Le garde-fou de taille ne contrôle plus l'ancienne table de partitions
  (`--anciens-socles` le rétablit).
- `npm run lint` et `npm run types` fonctionnent aussi sous Windows.
- L'avertissement d'export de l'application mentionne le mot de passe du broker,
  que le fichier contient.

### Corrigé

- L'identifiant du socle (`terraXXXXXX` : sujets MQTT, nom mDNS, point
  d'accès, appairage) était lu avant le démarrage du Wi-Fi. Avec le cœur
  ESP32 3.x, `WiFi.macAddress()` ne renvoie alors rien : l'identifiant venait
  de mémoire non initialisée et changeait d'une compilation à l'autre, si
  bien que l'application perdait le socle après une mise à jour. Il est
  désormais lu dans l'eFuse (`esp_read_mac`) : les trois derniers octets de
  l'adresse MAC Wi-Fi.
- Un échec de connexion MQTT n'apparaissait nulle part : le socle restait
  « hors ligne » dans l'application sans dire pourquoi. Le journal donne
  désormais la raison (identifiant ou mot de passe refusé, droits, erreur
  TLS, adresse introuvable), une fois par changement, ainsi que les
  coupures ; la commande `reseau` affiche l'état de la connexion.
- Avec le cœur ESP32 3.x, `setTimeout()` ne bornait plus la connexion MQTT
  chiffrée : un broker muet pouvait bloquer la boucle jusqu'à 120 s, bien
  au-delà du watchdog. Connexion et négociation TLS sont de nouveau
  limitées à 5 s chacune.

## [3.4.0] — 2026-10-14

Un socle en 3.3 passe en 3.4 par `/api/maj` ou depuis l'application ; il garde
alors son ancienne table de partitions (emplacements de 1,5 Mo), ce que le
garde-fou de taille continue de vérifier. Un reflashage par USB (page « Flasher
un socle », effacement complet accepté) installe la nouvelle table.

### Ajouté
- **Mise à jour tirée par le socle** (action MQTT `maj`, commande série `maj`,
  `/api/maj-distante`) : le socle télécharge lui-même le binaire d'une release
  GitHub en HTTPS (magasin de certificats du cœur, hôtes limités à
  `MAJ_HOTES_AUTORISES`), vérifie la signature si elle est exigée, coupe le
  chauffage le temps d'écrire, et publie sa progression sur le sujet `maj`.
  L'application affiche la carte **Mise à jour du firmware** (dernière version
  publiée lue dans `version.json`) avec un bouton pour lancer l'installation.
- **État de mise à jour persistant** (`EtatMaj`, NVS) : en validation, validée,
  retour arrière, échec — visible dans la santé (`maj`), l'interface locale et
  l'application, avec alerte en cas de retour arrière.
- **Nom d'hôte et réseau de configuration par socle** : `terraXXXXXX.local`
  (mDNS avec enregistrement TXT) et point d'accès `terrarium-config-XXXXXX`
  avec **portail captif** (DNS) : la page de configuration s'ouvre d'elle-même.
- **Improv Wi-Fi** sur la console série : la page « Flasher un socle » configure
  le Wi-Fi juste après le flashage, sans point d'accès ni saisie à l'écran.
  Commande série `wifi` qui essaie le réseau immédiatement (`Reseau::essayerWifi`).
- **Connexion par session** sur l'interface locale : défi/réponse SHA-256 (le
  mot de passe ne quitte pas le navigateur), cookie `HttpOnly` `SameSite=Strict`
  de 24 h, cinq échecs → pause d'une minute ; Basic conservé pour `curl` et les
  outils. La page est servie sans authentification, les API restent protégées.
- **Auto-test usine** (`test usine [oui]`) : écran, sondes, NVS, LittleFS,
  partitions, coredump, scan Wi-Fi, heure, INA219 et, sur demande, chaque
  MOSFET une fraction de seconde. Utilisé par `outils/provisionner.js` et le
  banc matériel.
- **Protocole 3** : action `maj`, sujet `maj`, champs `hote`, `ip` et `maj`
  dans la santé ; schéma JSON et simulateur à jour.
- **Serveur Terrariums** (`serveur/`, Node, Docker) : broker MQTT intégré avec
  comptes et droits par socle, rattachement d'un socle par la preuve de son code
  d'appairage, historique conservé application fermée, notifications **Web
  Push**, dépôt de rapports de diagnostic, pont vers un broker amont, API et
  outil d'administration. L'application le détecte à la connexion.
- Application : **code de verrouillage** (PBKDF2 300 000 tours → AES-GCM-256 sur
  le mot de passe du broker et les codes d'appairage, verrouillage automatique),
  **Trusted Types** (toute écriture HTML passe par une seule politique),
  minification à la publication avec cartes de sources, aide, mentions légales
  et confidentialité **en anglais**, fiche de **démarrage rapide imprimable**
  (`demarrage-rapide.html`, PDF joints à chaque release avec les deux manuels).
- Compilation **reproductible** (`SOURCE_DATE_EPOCH`, commit dans le binaire,
  `FW_BUILD` affiché) et **attestation de provenance** des binaires de release
  (`gh attestation verify`).
- Bancs sur PC : canal de commandes extrait dans `protocole.cpp` et testé sans
  Arduino (47 cas, fuzzé), **migration des réglages** testée (décalages figés
  par `static_assert`, relecture tolérante entre versions), couverture gcov par
  module (seuil 80 %), clang-tidy, sanitizers ; application : régression
  visuelle pixel à pixel, test de charge (100 socles, 10 applications),
  couverture c8, matrice WebKit/Firefox, CodeQL C++, banc matériel par port
  série (`test-materiel.js`, exécuteur auto-hébergé), hook de pré-commit.
- Documentation : `NOTICE.md` (licences embarquées), `docs/conformite.md`
  (CE, RED, CRA, DEEE, RGPD), `docs/produit.md`, `docs/securisation-serie.md`,
  décisions 0008 à 0010, `SECURITY.md` avec versions prises en charge.

### Modifié
- **Table de partitions** révisée : 2 × 1,69 Mo d'application (le binaire
  passe de 91 % à 81 % d'occupation) et 512 Ko de fichiers (≈ 11 jours
  d'historique). Les socles non reflashés par câble gardent l'ancienne table.
- Structures de réglages déplacées dans `reglages.h`, règle « ajout en fin de
  structure seulement » pour rester compatible d'une version à l'autre.
- Action `alim` validée par les mêmes bornes que les réglages globaux.
- Workflow de publication : bibliothèques épinglées, binaires reproductibles,
  PDF de documentation, notes de version mentionnant la mise à jour tirée.
- Outils de développement : ESLint 10 (avec `@eslint/js` et ses nouvelles
  règles), TypeScript 7, c8 12, mqtt.js 5.16 ; jsdom reste en 24 (la 30 casse
  le client WebSocket des bancs). Dependabot ne propose plus de montée de
  version majeure : chacune se fait à la main, suites de test à l'appui.

### Corrigé
- `strcat` sans borne dans la composition des libellés de défaut remplacé par un
  ajout borné (relevé par clang-tidy).
- Expression régulière de la démonstration qui laissait passer un identifiant
  mal formé (`\d` dans un gabarit de chaîne).
- Le schéma JSON et les tests n'admettaient que des identifiants hexadécimaux ;
  ils acceptent `terra` suivi de six caractères alphanumériques (celui du
  simulateur compris).

## [3.3.0] — 2026-10-13

### Ajouté
- **Retour arrière automatique** après une mise à jour : une image qui plante
  dans la minute et demie n'est jamais validée, le chargeur relance la précédente.
- **Rapport de plantage** : au redémarrage après une panique, résumé du coredump
  (tâche, compteur de programme, pile) dans le journal, les alertes et
  l'interface ; fichier complet sur `/api/coredump`.
- **Santé du socle** publiée (sujet MQTT `sante`, réponse `etat`, `/api/status`) :
  signal Wi-Fi, mémoire libre et plus grand bloc, uptime, cause du dernier
  redémarrage, mise à jour en attente de validation.
- **Alertes au format texte** (`formatAlertes`) avec titre et priorité : ntfy et
  consorts affichent directement une notification sur le téléphone.
- **Images de mise à jour signées** (ECDSA P-256) exigées par `/api/maj` quand
  `OTA_CLE_PUBLIQUE` est renseignée ; `outils/signer-firmware.js`.
- **QR code d'appairage sur l'écran** OLED, à côté du code en toutes lettres
  (encodeur `qr.cpp`, testé sur PC et relu par un décodeur indépendant).
- **Mesure de courant** facultative (INA219, `INA219_ACTIF`) : tapis coupé,
  MOSFET passant, kWh réels.
- **Commandes rejouées sans effet** : une requête déjà traitée reçoit à nouveau
  sa réponse, ce qui rend le QoS 1 sûr.
- Commandes série `sante`, `coredump [effacer]`, `appairage`.
- Application : français/anglais, dialogues de confirmation de la page et
  retrait de socle annulable, bouton d'installation, pastille sur l'icône,
  vibration sur un défaut, écrans d'attente, « tester la connexion »,
  diagnostic avec rapport copiable, export/import de la configuration et des
  réglages d'un socle, historique local sur 7 et 30 jours, zoom et export CSV
  des courbes, pages d'aide, de flashage, mentions légales et confidentialité.
- Outils : installateur web (ESP Web Tools), publication automatisée
  (`preparer-publication.js`, release par étiquette), ESLint, `tsc --checkJs`,
  Lighthouse CI, axe-core, test en Chromium réel, fuzzing libFuzzer, schéma
  JSON du protocole, garde-fou de taille du firmware, scénario d'endurance de
  7 jours avec passage de `millis()` à zéro.

### Modifié
- Publication MQTT **sur changement** (au plus toutes les 2 s, au moins toutes
  les 60 s) au lieu d'une cadence fixe de 20 s.
- Version de protocole **2** (`PROTO_VERSION`) : l'application signale un socle
  ou une application à mettre à jour.
- Interface web embarquée au même langage visuel que l'application, clair et sombre.
- Client MQTT de l'application : publication en QoS 1 avec réémission.

### Corrigé
- Charge (`duty`) qui pouvait dépasser 100 % d'une fraction de tour de boucle
  (trouvé par le fuzzing).
- Une valeur non finie glissée dans la régulation traversait les bornes.

## [3.2.0] — 2026-09

- Deux tapis, un seul alimenté à la fois ; partition sur mesure ; identifiant de
  l'appareil exposé ; page embarquée compressée ; application réécrite (clair
  façon PETKIT, sombre automatique) avec son propre client MQTT.
